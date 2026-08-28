import { Injectable } from '@nestjs/common';
import { ShipmentProvider, ShipmentStatus, DeliveryPartnerType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.module';
import { findNearestDeliveryPartner } from '../../../common';
import { CreateShipmentInput, CreateShipmentResult, ShipmentProviderAdapter, ShipmentStatusResult } from './provider-adapter.interface';

const MOCK_SETTING_DEFAULTS: Record<string, number> = {
  delivery_demo_pickup_minutes: 2,
  delivery_demo_transit_minutes: 5,
  delivery_demo_outfordelivery_minutes: 8,
  delivery_demo_delivered_minutes: 10,
};

// Widest reasonable search radius to find ANY available courier for a demo shipment — larger
// than the real eligibility engine's instant/same-day radii (this is just "is anyone even
// registered nearby", not a delivery-speed promise).
const MOCK_PARTNER_SEARCH_RADIUS_KM = 30;

const PROVIDER_LABEL = 'Demo Courier (Simulated — not a real courier)';

// No real hyperlocal/courier account exists yet — this simulates one so the full
// order -> shipment -> tracked delivery lifecycle is testable end-to-end today. Every
// output is unmistakably marked as demo data (isDemo:true, the label above, "DEMO-"
// tracking refs) so it can never be confused with a real courier integration. Status is
// computed fresh from elapsed wall-clock time on every call — deterministic, no
// polling/webhook/cron infrastructure needed — and the demo speed is admin-configurable via
// the existing SiteSetting (group 'delivery') so a full lifecycle is watchable in minutes.
@Injectable()
export class MockDeliveryProvider implements ShipmentProviderAdapter {
  readonly name = ShipmentProvider.MOCK_DEMO;

  constructor(private prisma: PrismaService) {}

  private async getSettingNumber(key: string): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : MOCK_SETTING_DEFAULTS[key];
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const providerRef = 'DEMO-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const deliveredMinutes = await this.getSettingNumber('delivery_demo_delivered_minutes');
    const estimatedDelivery = new Date(Date.now() + deliveredMinutes * 60000);

    // Phase 5 — best-effort rider allocation, reusing the same matcher DeliveryService's
    // (previously dead-code) assignForOrder() already used. Never blocks shipment creation:
    // if nobody is registered/available nearby, the shipment simply has no rider yet, exactly
    // like today's behaviour.
    let deliveryPartnerId: string | undefined;
    if (input.dropLat != null && input.dropLng != null) {
      const partner = await findNearestDeliveryPartner(
        this.prisma, DeliveryPartnerType.COURIER, input.dropLat, input.dropLng, MOCK_PARTNER_SEARCH_RADIUS_KM,
      );
      deliveryPartnerId = partner?.id;
    }

    return { providerRef, estimatedDelivery, deliveryPartnerId };
  }

  // Pure elapsed-time simulation — this remains the fallback used ONLY when no real
  // DeliveryPartner is assigned to the shipment (see ShipmentService.getShipmentStatus()'s
  // caller-side check). Once a rider is assigned, the rider's own explicit status updates
  // (DeliveryController) are the sole source of truth and this method is not consulted.
  async getStatus(providerRef: string, createdAt: Date): Promise<ShipmentStatusResult> {
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;
    const [pickupMin, transitMin, outForDeliveryMin, deliveredMin] = await Promise.all([
      this.getSettingNumber('delivery_demo_pickup_minutes'),
      this.getSettingNumber('delivery_demo_transit_minutes'),
      this.getSettingNumber('delivery_demo_outfordelivery_minutes'),
      this.getSettingNumber('delivery_demo_delivered_minutes'),
    ]);

    let status: ShipmentStatus;
    if (elapsedMinutes >= deliveredMin) status = ShipmentStatus.DELIVERED;
    else if (elapsedMinutes >= outForDeliveryMin) status = ShipmentStatus.OUT_FOR_DELIVERY;
    else if (elapsedMinutes >= transitMin) status = ShipmentStatus.IN_TRANSIT;
    else if (elapsedMinutes >= pickupMin) status = ShipmentStatus.PICKED_UP;
    else status = ShipmentStatus.CREATED;

    return { status, providerLabel: PROVIDER_LABEL, isDemo: true };
  }
}
