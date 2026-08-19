import { DispatchService } from './orders.module';

/**
 * Full lifecycle audit finding: Address.latitude/longitude default to 0 (not null) in the
 * schema, so an order created without a real GPS fix (or with a client-side geolocation
 * denial) was silently run through haversineKm against (0,0) — a point thousands of km from
 * every real vendor — permanently excluding every candidate with no error surfaced anywhere.
 * dispatch() must instead detect "no usable GPS" and fall back to city-text matching (the
 * same fallback RoutingService's in-house auto-assign already uses), so the order still gets
 * a real dispatch wave.
 */
function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const events: any = { emit: jest.fn() };
  return { service: new DispatchService(prisma, events), prisma, events };
}

describe('DispatchService.dispatch — no valid order GPS falls back to city matching', () => {
  it('queries by baseCity (case-insensitive) instead of GPS radius when address coords are (0,0)', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: 0, longitude: 0, city: 'Bhopal' },
      service: { category: { key: 'PLUMBING' } },
    });

    await service.dispatch('order-1');

    const where = prisma.serviceVendor.findMany.mock.calls[0][0].where;
    expect(where.baseCity).toEqual({ equals: 'Bhopal', mode: 'insensitive' });
    expect(where.currentLatitude).toBeUndefined();
    expect(where.lastLocationUpdate).toBeUndefined();
  });

  it('still uses GPS-radius matching when the order has real, valid coordinates', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: 23.25, longitude: 77.41, city: 'Bhopal' },
      service: { category: { key: 'PLUMBING' } },
    });

    await service.dispatch('order-1');

    const where = prisma.serviceVendor.findMany.mock.calls[0][0].where;
    expect(where.currentLatitude).toEqual({ not: null });
    expect(where.baseCity).toBeUndefined();
  });

  it('dispatches to zero candidates (not an error) when there is neither valid GPS nor a city on the order', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: 0, longitude: 0, city: '' },
      service: { category: { key: 'PLUMBING' } },
    });

    const result = await service.dispatch('order-1');

    expect(result).toEqual([]);
    expect(prisma.serviceVendor.findMany).not.toHaveBeenCalled();
  });
});
