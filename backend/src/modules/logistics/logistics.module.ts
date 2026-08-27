import { Module, Injectable, Controller, Get, Query, Param, UseGuards, BadRequestException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryTier } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { Public, JwtAuthGuard, CurrentUser, JwtPayload, haversineKm, isValidIndiaCoords } from '../../common';
import { MockDeliveryProvider } from './providers/mock-provider';
import { ShipmentProviderAdapter } from './providers/provider-adapter.interface';

// Phase 2 — delivery-speed ELIGIBILITY DECISION ENGINE for product orders. See the plan doc
// "Phase 2 — Delivery Eligibility Engine" for the full design. Deliberately separate from
// DeliveryModule (delivery.module.ts) — the existing in-house rider-dispatch/fulfillment
// system. This module only decides which tier an order *should* get; it never assigns a
// rider or touches a Delivery row. Order.deliveryTier/deliveryCharge are schema scaffolding
// only in this phase — nothing in checkout reads or requires them yet.
const DELIVERY_SETTING_DEFAULTS: Record<string, number> = {
  delivery_local_radius_km: 50,
  delivery_instant_radius_km: 5,
  delivery_sameday_radius_km: 15,
  delivery_instant_cutoff_hour: 20,
  delivery_sameday_cutoff_hour: 16,
  delivery_max_weight_kg_fast: 10,
  delivery_charge_instant: 79,
  delivery_charge_sameday: 39,
  delivery_charge_nextday: 19,
  delivery_charge_standard: 0,
};

interface EligibilityResult {
  tier: DeliveryTier;
  etaLabel: string;
  charge: number;
  distanceKm: number | null;
  reasons: string[];
}

@Injectable()
export class LogisticsService {
  constructor(private prisma: PrismaService) {}

  private async getSettingNumber(key: string): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : DELIVERY_SETTING_DEFAULTS[key];
  }

  private parseHourMinute(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  // Railway's container runs with no TZ set (confirmed: Dockerfile/env has none), which
  // means Date.getHours() reads UTC, not IST — a "20:00 cutoff" admins configure meaning
  // 8 PM India time would otherwise actually fire at 1:30 AM IST. India has a single,
  // DST-free +5:30 offset, so shifting the UTC epoch and reading UTC components back off
  // the shifted timestamp gives the correct IST wall-clock reading regardless of the
  // server process's own timezone.
  private istMinutesOfDay(date: Date): number {
    const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }

  private isWithinOperatingHours(open: string | null, close: string | null, now: Date): boolean {
    if (!open || !close) return true; // no restriction configured
    const nowMinutes = this.istMinutesOfDay(now);
    const openMinutes = this.parseHourMinute(open);
    const closeMinutes = this.parseHourMinute(close);
    if (closeMinutes <= openMinutes) return true; // malformed config — don't block on it
    return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
  }

  async checkEligibility(params: {
    productId: string;
    addressId?: string;
    lat?: number;
    lng?: number;
    city?: string;
  }): Promise<EligibilityResult> {
    const product = await this.prisma.product.findUnique({
      where: { id: params.productId },
      include: { vendor: { include: { pickupLocations: { where: { isActive: true } } } } },
    });
    if (!product) throw new BadRequestException('Product not found');

    const reasons: string[] = [];
    const standard = async (reason: string): Promise<EligibilityResult> => {
      reasons.push(reason);
      return { tier: DeliveryTier.STANDARD, etaLabel: '2-7 days', charge: await this.getSettingNumber('delivery_charge_standard'), distanceKm: null, reasons };
    };

    const vendor = product.vendor;
    if (!vendor || !vendor.pickupLocations.length) {
      return standard('No active pickup location for this seller');
    }

    // Resolve customer coordinates — from a saved Address, or raw lat/lng/city passed by a
    // guest checkout. Same GPS-first-then-city-fallback spirit as isVendorLocationEligible
    // (common/index.ts), adapted for a static PickupLocation instead of a live-GPS vendor.
    let custLat: number | null = null, custLng: number | null = null, custCity: string | null = null;
    if (params.addressId) {
      const address = await this.prisma.address.findUnique({ where: { id: params.addressId } });
      if (address) { custLat = address.latitude; custLng = address.longitude; custCity = address.city; }
    } else {
      custLat = params.lat ?? null; custLng = params.lng ?? null; custCity = params.city ?? null;
    }

    let distanceKm: number | null = null;
    if (isValidIndiaCoords(custLat, custLng)) {
      distanceKm = Math.min(...vendor.pickupLocations.map((p) => haversineKm(p.latitude, p.longitude, custLat!, custLng!)));
    }

    const localRadiusKm = await this.getSettingNumber('delivery_local_radius_km');
    const isLocal = distanceKm != null
      ? distanceKm <= localRadiusKm
      : !!custCity && vendor.pickupLocations.some((p) => p.city.toLowerCase() === custCity!.toLowerCase());
    if (!isLocal) {
      return standard('Outside local delivery area — falls back to standard/national delivery');
    }

    // Seller availability
    const now = new Date();
    if (!vendor.isOpen) {
      reasons.push('Seller is currently marked closed');
      return this.resolveFallbackTier(vendor, reasons);
    }
    if (!this.isWithinOperatingHours(vendor.operatingHoursOpen, vendor.operatingHoursClose, now)) {
      reasons.push('Outside seller operating hours');
      return this.resolveFallbackTier(vendor, reasons);
    }

    // Product eligibility — null weight (most pre-existing products) is treated as eligible
    // by default so nothing already listed silently loses fast delivery.
    const maxWeightKgFast = await this.getSettingNumber('delivery_max_weight_kg_fast');
    if (product.weightKg != null && Number(product.weightKg) > maxWeightKgFast) {
      reasons.push(`Product too heavy for fast delivery (${product.weightKg}kg > ${maxWeightKgFast}kg limit)`);
      return this.resolveFallbackTier(vendor, reasons, /* capNextDayOnly */ true);
    }

    // Cutoff + radius ceilings — take the strictest surviving tier.
    const instantCutoffHour = await this.getSettingNumber('delivery_instant_cutoff_hour');
    const sameDayCutoffHour = await this.getSettingNumber('delivery_sameday_cutoff_hour');
    const instantRadiusKm = await this.getSettingNumber('delivery_instant_radius_km');
    const sameDayRadiusKm = await this.getSettingNumber('delivery_sameday_radius_km');

    const effectiveNow = new Date(now.getTime() + vendor.processingTimeMinutes * 60000);
    const effectiveIstHour = Math.floor(this.istMinutesOfDay(effectiveNow) / 60);
    const withinInstantTime = effectiveIstHour < instantCutoffHour;
    const withinSameDayTime = effectiveIstHour < sameDayCutoffHour;
    const withinInstantRadius = distanceKm == null || distanceKm <= instantRadiusKm;
    const withinSameDayRadius = distanceKm == null || distanceKm <= sameDayRadiusKm;

    if (vendor.offersInstantDelivery && withinInstantTime && withinInstantRadius) {
      return { tier: DeliveryTier.INSTANT, etaLabel: '30-120 min', charge: await this.getSettingNumber('delivery_charge_instant'), distanceKm, reasons };
    }
    if (vendor.offersSameDayDelivery && withinSameDayTime && withinSameDayRadius) {
      return { tier: DeliveryTier.SAME_DAY, etaLabel: 'Today, evening slot', charge: await this.getSettingNumber('delivery_charge_sameday'), distanceKm, reasons };
    }
    if (!withinInstantTime) reasons.push('Past instant-delivery cutoff time');
    if (!withinSameDayTime) reasons.push('Past same-day cutoff time');
    if (!withinInstantRadius) reasons.push(`Beyond instant-delivery radius (${distanceKm?.toFixed(1)}km > ${instantRadiusKm}km)`);
    if (!withinSameDayRadius) reasons.push(`Beyond same-day radius (${distanceKm?.toFixed(1)}km > ${sameDayRadiusKm}km)`);
    return { tier: DeliveryTier.NEXT_DAY, etaLabel: 'Tomorrow', charge: await this.getSettingNumber('delivery_charge_nextday'), distanceKm, reasons };
  }

  // Seller closed / outside hours / product too heavy for fast tiers — best possible is
  // Next-Day if the seller offers any fast tier at all, else Standard.
  private async resolveFallbackTier(
    vendor: { offersInstantDelivery: boolean; offersSameDayDelivery: boolean },
    reasons: string[],
    capNextDayOnly = false,
  ): Promise<EligibilityResult> {
    if (!capNextDayOnly && !vendor.offersInstantDelivery && !vendor.offersSameDayDelivery) {
      return { tier: DeliveryTier.STANDARD, etaLabel: '2-7 days', charge: await this.getSettingNumber('delivery_charge_standard'), distanceKm: null, reasons };
    }
    return { tier: DeliveryTier.NEXT_DAY, etaLabel: 'Tomorrow', charge: await this.getSettingNumber('delivery_charge_nextday'), distanceKm: null, reasons };
  }
}

@ApiTags('Logistics')
@Controller('logistics')
export class LogisticsController {
  constructor(private logistics: LogisticsService) {}

  @Public()
  @Get('delivery-eligibility')
  eligibility(
    @Query('productId') productId: string,
    @Query('addressId') addressId?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('city') city?: string,
  ) {
    if (!productId) throw new BadRequestException('productId is required');
    return this.logistics.checkEligibility({
      productId, addressId,
      lat: lat !== undefined ? Number(lat) : undefined,
      lng: lng !== undefined ? Number(lng) : undefined,
      city,
    });
  }
}

// Phase 3 — provider-agnostic shipment lifecycle. Only MOCK_DEMO is registered today (no
// real hyperlocal/courier account exists) — adding a real provider later means writing one
// new ShipmentProviderAdapter implementation and adding it here; nothing about Order,
// checkout, or this service's own logic needs to change.
@Injectable()
export class ShipmentService {
  private readonly logger = new Logger(ShipmentService.name);
  private readonly providers: Record<string, ShipmentProviderAdapter>;

  constructor(private prisma: PrismaService, private logistics: LogisticsService, mockProvider: MockDeliveryProvider) {
    this.providers = { MOCK_DEMO: mockProvider };
  }

  private getProvider(): ShipmentProviderAdapter {
    return this.providers.MOCK_DEMO;
  }

  // Called as a best-effort side effect right after checkout has already succeeded — never
  // allowed to fail or delay the checkout response itself (see call site in
  // master-orders.module.ts). Deliberately creates a demo shipment for EVERY product order
  // with a resolvable address, regardless of eligibility tier (including STANDARD and
  // no-vendor products) — there's no real national-courier integration either yet, so this
  // is what makes the "whole lifecycle testable end-to-end" today.
  async createShipmentForOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { include: { vendor: { include: { pickupLocations: { where: { isActive: true } } } } } } }, take: 1 }, address: true },
    });
    if (!order || !order.items.length || !order.addressId) return; // service-only or address-less orders: nothing to ship
    const firstProduct = order.items[0].product;
    if (!firstProduct) return;

    const eligibility = await this.logistics.checkEligibility({ productId: firstProduct.id, addressId: order.addressId });
    await this.prisma.order.update({ where: { id: orderId }, data: { deliveryTier: eligibility.tier, deliveryCharge: eligibility.charge } });

    const pickup = firstProduct.vendor?.pickupLocations[0];
    const provider = this.getProvider();
    const { providerRef, estimatedDelivery } = await provider.createShipment({
      orderId,
      tier: eligibility.tier,
      pickupLat: pickup?.latitude ?? null,
      pickupLng: pickup?.longitude ?? null,
      dropLat: order.address?.latitude ?? null,
      dropLng: order.address?.longitude ?? null,
    });

    await this.prisma.shipment.create({
      data: { orderId, provider: provider.name, providerRef, tier: eligibility.tier, estimatedDelivery, isDemo: true },
    });
  }

  async getShipmentStatus(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { shipment: true, vendor: { select: { userId: true } } } });
    if (!order) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    if (!order.shipment) return { hasShipment: false };

    const live = await this.getProvider().getStatus(order.shipment.providerRef, order.shipment.createdAt);
    if (live.status !== order.shipment.status) {
      await this.prisma.shipment.update({ where: { id: order.shipment.id }, data: { status: live.status } });
    }
    return {
      hasShipment: true,
      tier: order.shipment.tier,
      status: live.status,
      estimatedDelivery: order.shipment.estimatedDelivery,
      isDemo: live.isDemo,
      providerLabel: live.providerLabel,
    };
  }
}

@ApiTags('Logistics')
@ApiBearerAuth()
@Controller('logistics')
export class ShipmentController {
  constructor(private shipments: ShipmentService) {}

  @UseGuards(JwtAuthGuard)
  @Get('shipments/:orderId')
  status(@CurrentUser() u: JwtPayload, @Param('orderId') orderId: string) {
    return this.shipments.getShipmentStatus(orderId, u.sub);
  }
}

@Module({
  controllers: [LogisticsController, ShipmentController],
  providers: [LogisticsService, ShipmentService, MockDeliveryProvider],
  exports: [LogisticsService, ShipmentService],
})
export class LogisticsModule {}
