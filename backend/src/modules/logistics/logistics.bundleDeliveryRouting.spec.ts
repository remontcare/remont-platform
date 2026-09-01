import { ShipmentService, LogisticsService } from './logistics.module';

/**
 * Bundle offer (see master-orders.bundleOffer.spec.ts for the checkout-time discount math)
 * — the SERVICE child of a product+service bundle is deliberately never routed to a
 * partner at checkout (Order.bundleDispatchDeferred = true). onShipmentDelivered() is the
 * other half: once a PRODUCT child in the same MasterOrder is delivered, it must check
 * whether EVERY sibling PRODUCT child has now been delivered, and only then route the
 * deferred SERVICE sibling(s) — never early, never twice.
 */
function makeService(initialOrders: Record<string, any>) {
  const orders: Record<string, any> = JSON.parse(JSON.stringify(initialOrders));
  const prisma: any = {
    order: {
      findUnique: jest.fn(async ({ where }: any) => (where.id in orders ? { ...orders[where.id] } : null)),
      findMany: jest.fn(async ({ where }: any) => {
        return Object.values(orders).filter((o: any) => {
          if (where.masterOrderId && o.masterOrderId !== where.masterOrderId) return false;
          if (where.type && o.type !== where.type) return false;
          if (where.bundleDispatchDeferred !== undefined && o.bundleDispatchDeferred !== where.bundleDispatchDeferred) return false;
          return true;
        }).map((o: any) => ({ ...o }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const o = orders[where.id];
        if (!o) return { count: 0 };
        if (where.status && where.status.not && o.status === where.status.not) return { count: 0 };
        if (where.bundleDispatchDeferred !== undefined && o.bundleDispatchDeferred !== where.bundleDispatchDeferred) return { count: 0 };
        Object.assign(o, data);
        return { count: 1 };
      }),
    },
    orderTimeline: { create: jest.fn(async () => ({})) },
    shipment: { findUnique: jest.fn(async () => null) }, // no shipment row → settlement branch is skipped, isolating this test to the routing logic
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const logistics: any = {};
  const mockProvider: any = { name: 'MOCK_DEMO' };
  const rateEngine: any = { pickCostReferenceProvider: jest.fn().mockResolvedValue(null) };
  const productLedger: any = { settleProductOrder: jest.fn() };
  const routing: any = { route: jest.fn(async () => {}) };
  const service = new ShipmentService(prisma, logistics as LogisticsService, mockProvider, rateEngine, productLedger, routing);
  return { service, orders, routing };
}

describe('ShipmentService.onShipmentDelivered — bundle offer deferred dispatch', () => {
  it('a single-product bundle: delivering the product immediately routes the deferred service sibling', async () => {
    const { service, routing } = makeService({
      'prod-1': { id: 'prod-1', type: 'PRODUCT', serviceId: null, masterOrderId: 'mo-1', status: 'CONFIRMED' },
      'svc-1': { id: 'svc-1', type: 'SERVICE', serviceId: 'fan-install', masterOrderId: 'mo-1', status: 'CONFIRMED', bundleDispatchDeferred: true },
    });
    await service.onShipmentDelivered('prod-1');
    expect(routing.route).toHaveBeenCalledWith('svc-1');
    expect(routing.route).toHaveBeenCalledTimes(1);
  });

  it('a multi-product bundle: the service is NOT routed until ALL product siblings are delivered', async () => {
    const { service, orders, routing } = makeService({
      'prod-1': { id: 'prod-1', type: 'PRODUCT', serviceId: null, masterOrderId: 'mo-2', status: 'CONFIRMED' },
      'prod-2': { id: 'prod-2', type: 'PRODUCT', serviceId: null, masterOrderId: 'mo-2', status: 'CONFIRMED' },
      'svc-1': { id: 'svc-1', type: 'SERVICE', serviceId: 'fan-install', masterOrderId: 'mo-2', status: 'CONFIRMED', bundleDispatchDeferred: true },
    });

    await service.onShipmentDelivered('prod-1');
    expect(routing.route).not.toHaveBeenCalled(); // prod-2 still undelivered

    // prod-2 now delivered too — the deferred service should route now.
    orders['prod-2'].status = 'CONFIRMED'; // (still not COMPLETED — the claim below is what flips it)
    await service.onShipmentDelivered('prod-2');
    expect(routing.route).toHaveBeenCalledWith('svc-1');
    expect(routing.route).toHaveBeenCalledTimes(1);
  });

  it('a non-bundle PRODUCT order (no masterOrderId) never touches routing at all', async () => {
    const { service, routing } = makeService({
      'prod-solo': { id: 'prod-solo', type: 'PRODUCT', serviceId: null, masterOrderId: null, status: 'CONFIRMED' },
    });
    await service.onShipmentDelivered('prod-solo');
    expect(routing.route).not.toHaveBeenCalled();
  });

  it('double-fire (the documented re-entrancy case) never routes the same deferred service twice', async () => {
    const { service, routing } = makeService({
      'prod-1': { id: 'prod-1', type: 'PRODUCT', serviceId: null, masterOrderId: 'mo-3', status: 'CONFIRMED' },
      'svc-1': { id: 'svc-1', type: 'SERVICE', serviceId: 'fan-install', masterOrderId: 'mo-3', status: 'CONFIRMED', bundleDispatchDeferred: true },
    });
    // onShipmentDelivered() is documented as reachable twice for the same order (explicit
    // status update + polling fallback) — the outer status===COMPLETED claim guard means
    // only the FIRST call reaches this far; simulate that directly.
    await service.onShipmentDelivered('prod-1');
    await service.onShipmentDelivered('prod-1'); // second call: the COMPLETED claim now fails fast, returns before the routing check
    expect(routing.route).toHaveBeenCalledTimes(1);
  });

  it('a bundle service child that was NOT deferred (already routed some other way) is left alone', async () => {
    const { service, routing } = makeService({
      'prod-1': { id: 'prod-1', type: 'PRODUCT', serviceId: null, masterOrderId: 'mo-4', status: 'CONFIRMED' },
      'svc-1': { id: 'svc-1', type: 'SERVICE', serviceId: 'fan-install', masterOrderId: 'mo-4', status: 'CONFIRMED', bundleDispatchDeferred: false },
    });
    await service.onShipmentDelivered('prod-1');
    expect(routing.route).not.toHaveBeenCalled();
  });
});
