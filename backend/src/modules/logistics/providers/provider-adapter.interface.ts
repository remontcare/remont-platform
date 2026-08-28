import { ShipmentProvider, ShipmentStatus, DeliveryTier } from '@prisma/client';

// The one contract every shipment fulfillment provider implements — the only file a real
// provider integration (Porter, Shiprocket, etc.) needs to add later. Nothing in
// ShipmentService, checkout, or the Order/Shipment schema needs to change to add one; only
// PROVIDER_REGISTRY in shipment.service.ts needs a new entry.
export interface CreateShipmentInput {
  orderId: string;
  tier: DeliveryTier;
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropLat?: number | null;
  dropLng?: number | null;
}

export interface CreateShipmentResult {
  providerRef: string;
  estimatedDelivery: Date;
  // Phase 5 — best-effort rider allocation. Optional: a real future provider that manages its
  // own riders (rather than ours) simply omits this.
  deliveryPartnerId?: string;
}

export interface ShipmentStatusResult {
  status: ShipmentStatus;
  providerLabel: string;
  isDemo: boolean;
}

export interface ShipmentProviderAdapter {
  readonly name: ShipmentProvider;
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  // `createdAt` is passed in (rather than the adapter tracking its own state) so a stateless,
  // deterministic mock can compute "how far along should this be by now" purely from elapsed
  // time — no polling loop, webhook, or cron needed to keep it moving.
  getStatus(providerRef: string, createdAt: Date): Promise<ShipmentStatusResult>;
}
