import { Injectable } from '@nestjs/common';
import { ShipmentProvider, ShipmentStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.module';
import { CreateShipmentInput, CreateShipmentResult, ShipmentProviderAdapter, ShipmentStatusResult } from './provider-adapter.interface';

const MOCK_SETTING_DEFAULTS: Record<string, number> = {
  delivery_demo_pickup_minutes: 2,
  delivery_demo_transit_minutes: 5,
  delivery_demo_delivered_minutes: 10,
};

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
    return { providerRef, estimatedDelivery };
  }

  async getStatus(providerRef: string, createdAt: Date): Promise<ShipmentStatusResult> {
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;
    const [pickupMin, transitMin, deliveredMin] = await Promise.all([
      this.getSettingNumber('delivery_demo_pickup_minutes'),
      this.getSettingNumber('delivery_demo_transit_minutes'),
      this.getSettingNumber('delivery_demo_delivered_minutes'),
    ]);

    let status: ShipmentStatus;
    if (elapsedMinutes >= deliveredMin) status = ShipmentStatus.DELIVERED;
    else if (elapsedMinutes >= transitMin) status = ShipmentStatus.IN_TRANSIT;
    else if (elapsedMinutes >= pickupMin) status = ShipmentStatus.PICKED_UP;
    else status = ShipmentStatus.CREATED;

    return { status, providerLabel: PROVIDER_LABEL, isDemo: true };
  }
}
