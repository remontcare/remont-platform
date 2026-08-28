import { Module, Injectable, Controller, Get, Post, Body, Query, Param, UseGuards, BadRequestException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryTier, CodSettlementStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { Public, JwtAuthGuard, CurrentUser, JwtPayload, haversineKm, isValidIndiaCoords, writeOrderTimeline } from '../../common';
import { MockDeliveryProvider } from './providers/mock-provider';
import { ShipmentProviderAdapter } from './providers/provider-adapter.interface';
import { ReverseLogisticsRateEngine } from './reverse-logistics-rate-engine';

// Phase 5 — COD settlement ladder adjacency, same idiom as DeliveryController's
// SHIPMENT_STATUS_NEXT. Rejects an out-of-order or duplicate call instead of silently no-op-ing.
const COD_STATUS_NEXT: Record<CodSettlementStatus, CodSettlementStatus[]> = {
  NOT_APPLICABLE: [],
  COD_EXPECTED: [CodSettlementStatus.COD_COLLECTED],
  COD_COLLECTED: [CodSettlementStatus.COD_SETTLEMENT_PENDING],
  COD_SETTLEMENT_PENDING: [CodSettlementStatus.COD_SETTLED],
  COD_SETTLED: [CodSettlementStatus.COD_RECONCILED],
  COD_RECONCILED: [],
};

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

  // Phase 4 — checkout-preview aggregate for the frontend cart summary (not the source of
  // truth for billing; MasterOrdersService.checkout() computes its own authoritative charge
  // per group independently). Groups distinct products by vendorId — a simpler, self-
  // contained grouping than reusing groupCartForSplit() (master-orders.module.ts), which
  // also handles services/commission concerns this preview doesn't need. Products with no
  // vendor are grouped together under `null` (consistent with checkout treating them as one
  // "unassigned" bucket).
  async estimateCartDeliveryCharge(params: {
    items: { productId: string; quantity?: number }[];
    addressId?: string;
    lat?: number;
    lng?: number;
    city?: string;
  }): Promise<{ totalDeliveryCharge: number; breakdown: { vendorId: string | null; tier: DeliveryTier; charge: number }[] }> {
    const productIds = [...new Set(params.items.map((i) => i.productId))];
    if (!productIds.length) return { totalDeliveryCharge: 0, breakdown: [] };
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, vendorId: true } });
    const vendorIds = [...new Set(products.map((p) => p.vendorId))];
    const breakdown = await Promise.all(vendorIds.map(async (vendorId) => {
      const representativeProduct = products.find((p) => p.vendorId === vendorId)!;
      const eligibility = await this.checkEligibility({
        productId: representativeProduct.id, addressId: params.addressId, lat: params.lat, lng: params.lng, city: params.city,
      });
      return { vendorId, tier: eligibility.tier, charge: eligibility.charge };
    }));
    const totalDeliveryCharge = breakdown.reduce((s, b) => s + b.charge, 0);
    return { totalDeliveryCharge, breakdown };
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

  // Checkout-preview only — see estimateCartDeliveryCharge()'s comment. Never the source of
  // truth for what's actually billed.
  @Public()
  @Post('delivery-charge-estimate')
  deliveryChargeEstimate(@Body() body: { items: { productId: string; quantity?: number }[]; addressId?: string; lat?: number; lng?: number; city?: string }) {
    if (!body?.items?.length) return { totalDeliveryCharge: 0, breakdown: [] };
    return this.logistics.estimateCartDeliveryCharge(body);
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

  // Phase 5 — called once the SELLER marks the order ready-for-pickup (ProductVendorsService.
  // markReadyForPickup(), vendors.module.ts), never right after payment anymore. Before Phase
  // 5 this fired immediately on payment confirmation; the seller-processing window
  // (AWAITING_SELLER -> SELLER_ACCEPTED -> PROCESSING -> READY_FOR_PICKUP) now happens first.
  async createShipmentForOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { include: { vendor: { include: { pickupLocations: { where: { isActive: true } } } } } } }, take: 1 }, address: true },
    });
    if (!order || !order.items.length || !order.addressId) return; // service-only or address-less orders: nothing to ship
    // Defensive re-entrancy guard: a shipment must never be created before the seller has
    // actually packed the order. The Shipment.orderId @unique constraint is the hard backstop
    // behind this (a duplicate call after a shipment already exists throws, safely swallowed
    // by this method's best-effort callers).
    if (order.productFulfillmentStage !== 'READY_FOR_PICKUP') return;
    const firstProduct = order.items[0].product;
    if (!firstProduct) return;

    // Phase 4 — checkout (master-orders.module.ts) now computes and stores
    // deliveryTier/deliveryCharge on the Order at creation time, as part of pricing, so the
    // billed amount and the shipment's tier can never disagree. Read that instead of calling
    // checkEligibility() a second time here; only fall back to computing it if somehow still
    // null (should not happen for a PRODUCT order going forward, kept for defensiveness).
    let tier = order.deliveryTier;
    let charge = order.deliveryCharge != null ? Number(order.deliveryCharge) : 0;
    if (!tier) {
      const eligibility = await this.logistics.checkEligibility({ productId: firstProduct.id, addressId: order.addressId });
      tier = eligibility.tier;
      charge = eligibility.charge;
      await this.prisma.order.update({ where: { id: orderId }, data: { deliveryTier: tier, deliveryCharge: charge } });
    }

    const pickup = firstProduct.vendor?.pickupLocations[0];
    const provider = this.getProvider();
    const { providerRef, estimatedDelivery, deliveryPartnerId } = await provider.createShipment({
      orderId,
      tier,
      pickupLat: pickup?.latitude ?? null,
      pickupLng: pickup?.longitude ?? null,
      dropLat: order.address?.latitude ?? null,
      dropLng: order.address?.longitude ?? null,
    });

    const isCod = order.paymentMethod === 'COD';
    const deliveryOtp = Math.floor(1000 + Math.random() * 9000).toString();
    await this.prisma.shipment.create({
      data: {
        orderId, provider: provider.name, providerRef, tier, estimatedDelivery, isDemo: true,
        deliveryPartnerId, partnerAssignedAt: deliveryPartnerId ? new Date() : undefined,
        codAmount: isCod ? order.totalAmount : undefined,
        codSettlementStatus: isCod ? CodSettlementStatus.COD_EXPECTED : CodSettlementStatus.NOT_APPLICABLE,
        deliveryOtp,
      },
    });
    await this.prisma.order.update({ where: { id: orderId }, data: { productFulfillmentStage: 'HANDED_TO_LOGISTICS', productFulfillmentAt: new Date() } });
    await writeOrderTimeline(this.prisma, { orderId, status: 'SHIPMENT_CREATED', note: deliveryPartnerId ? 'Delivery partner assigned' : 'No delivery partner available yet' });
  }

  // Phase 5 — called by DeliveryController.updateShipmentStatus() once a rider marks a
  // Shipment DELIVERED. Product orders never had anything advance Order.status past CONFIRMED
  // before Phase 5; this is new, purely additive behaviour gated so it can never fire for a
  // SERVICE order or a bundle order's service child.
  async onShipmentDelivered(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.type !== 'PRODUCT' || order.serviceId) return;
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await writeOrderTimeline(this.prisma, { orderId, status: 'DELIVERED' });
  }

  async getShipmentStatus(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { shipment: true, vendor: { select: { userId: true } } } });
    if (!order) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    if (!order.shipment) return { hasShipment: false };

    // Once a real DeliveryPartner is assigned, the rider's own explicit status updates
    // (DeliveryController) are the sole source of truth — the elapsed-time demo simulation is
    // only consulted for a shipment with no rider assigned yet (preserves the pre-Phase-5 demo
    // auto-progression exactly as before for that case).
    let status = order.shipment.status;
    let isDemo = order.shipment.isDemo;
    let providerLabel: string | undefined;
    if (!order.shipment.deliveryPartnerId) {
      const live = await this.getProvider().getStatus(order.shipment.providerRef, order.shipment.createdAt);
      if (live.status !== order.shipment.status) {
        await this.prisma.shipment.update({ where: { id: order.shipment.id }, data: { status: live.status } });
        if (live.status === 'DELIVERED') await this.onShipmentDelivered(orderId);
      }
      status = live.status;
      isDemo = live.isDemo;
      providerLabel = live.providerLabel;
    }
    return {
      hasShipment: true,
      tier: order.shipment.tier,
      status,
      estimatedDelivery: order.shipment.estimatedDelivery,
      isDemo,
      providerLabel,
      deliveryPartnerAssigned: !!order.shipment.deliveryPartnerId,
      codSettlementStatus: order.shipment.codSettlementStatus,
    };
  }

  // ─── Phase 5 — COD settlement ladder ───────────────────────────────────────────────
  // Deliberately separate from ServiceVendor.pendingPayout/PartnerLedgerEntry — see schema
  // doc comment on CodSettlementStatus for why. Rider collects/hands over; admin settles/
  // reconciles. Every step validated against COD_STATUS_NEXT so a stale/duplicate/out-of-
  // order call is rejected, not silently ignored.

  private assertCodTransition(current: CodSettlementStatus, target: CodSettlementStatus) {
    if (!COD_STATUS_NEXT[current]?.includes(target)) {
      throw new BadRequestException(`Cannot move COD status from ${current} to ${target}`);
    }
  }

  async markCodCollected(shipmentId: string, deliveryPartnerId: string): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException();
    this.assertCodTransition(shipment.codSettlementStatus, CodSettlementStatus.COD_COLLECTED);
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { codSettlementStatus: CodSettlementStatus.COD_COLLECTED, codCollectedAt: new Date(), codCollectedBy: deliveryPartnerId },
    });
    await writeOrderTimeline(this.prisma, { orderId: shipment.orderId, status: 'COD_COLLECTED' });
  }

  // Batch hand-over — every one of this rider's COD_COLLECTED shipments moves to
  // COD_SETTLEMENT_PENDING at once ("I've physically handed today's cash to the hub").
  async codHandover(deliveryPartnerId: string): Promise<{ count: number }> {
    const result = await this.prisma.shipment.updateMany({
      where: { deliveryPartnerId, codSettlementStatus: CodSettlementStatus.COD_COLLECTED },
      data: { codSettlementStatus: CodSettlementStatus.COD_SETTLEMENT_PENDING, codHandedOverAt: new Date() },
    });
    return { count: result.count };
  }

  async codSettle(shipmentId: string, adminId: string): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException();
    this.assertCodTransition(shipment.codSettlementStatus, CodSettlementStatus.COD_SETTLED);
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { codSettlementStatus: CodSettlementStatus.COD_SETTLED, codSettledAt: new Date(), codSettledBy: adminId },
    });
    await writeOrderTimeline(this.prisma, { orderId: shipment.orderId, status: 'COD_SETTLED', actorId: adminId, actorRole: 'ADMIN' as any });
  }

  // Batch settle skips (does not fail on) any shipment already past COD_SETTLEMENT_PENDING —
  // one stale row shouldn't block the rest of a rider's handover batch.
  async codSettleBatch(shipmentIds: string[], adminId: string): Promise<{ settled: string[]; skipped: string[] }> {
    const settled: string[] = []; const skipped: string[] = [];
    for (const id of shipmentIds) {
      try { await this.codSettle(id, adminId); settled.push(id); } catch { skipped.push(id); }
    }
    return { settled, skipped };
  }

  async codReconcile(shipmentId: string, adminId: string): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException();
    this.assertCodTransition(shipment.codSettlementStatus, CodSettlementStatus.COD_RECONCILED);
    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { codSettlementStatus: CodSettlementStatus.COD_RECONCILED, codReconciledAt: new Date(), codReconciledBy: adminId },
    });
    await writeOrderTimeline(this.prisma, { orderId: shipment.orderId, status: 'COD_RECONCILED', actorId: adminId, actorRole: 'ADMIN' as any });
  }

  // Admin operations-queue listing (frontend/admin/logistics.html) — plain paginated list,
  // no admin action lives here (those are the codSettle/codReconcile methods above, exposed
  // via AdminController).
  async listShipments(filters: { codSettlementStatus?: CodSettlementStatus } = {}) {
    const shipments = await this.prisma.shipment.findMany({
      where: filters.codSettlementStatus ? { codSettlementStatus: filters.codSettlementStatus } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { order: { select: { orderNumber: true, customerId: true, totalAmount: true } }, deliveryPartner: { select: { id: true, user: { select: { name: true, phone: true } } } } },
    });
    return shipments;
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
  providers: [LogisticsService, ShipmentService, MockDeliveryProvider, ReverseLogisticsRateEngine],
  exports: [LogisticsService, ShipmentService, ReverseLogisticsRateEngine],
})
export class LogisticsModule {}
