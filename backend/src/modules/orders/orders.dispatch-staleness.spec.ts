import { DispatchService, RoutingService } from './orders.module';

// Partner Portal audit fix: DispatchService already used a vendor's GPS coordinates for
// distance-based matching, but never checked how OLD those coordinates were — a vendor
// who went offline hours/days ago without ever flipping isOnline:false would still count
// as "at" their stale last-known location. This asserts the new staleness cutoff is
// actually part of the candidate query, not just present in a comment.
describe('DispatchService.dispatch — stale GPS location is excluded from matching', () => {
  function makeService() {
    const prisma: any = {
      order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const events: any = { emit: jest.fn() };
    return { service: new DispatchService(prisma, events), prisma };
  }

  it('filters candidates on lastLocationUpdate being recent', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: 23.25, longitude: 77.41 },
      service: { category: { key: 'ELECTRICAL' } },
    });

    const before = Date.now();
    await service.dispatch('order-1');
    const after = Date.now();

    const where = prisma.serviceVendor.findMany.mock.calls[0][0].where;
    expect(where.lastLocationUpdate).toBeDefined();
    const cutoff = where.lastLocationUpdate.gte.getTime();
    // cutoff should be ~2 hours before "now" at call time, not unbounded/absent
    expect(cutoff).toBeLessThan(before - 60 * 60 * 1000);
    expect(cutoff).toBeGreaterThan(after - 3 * 60 * 60 * 1000);
  });
});

// Partner Portal audit fix: RoutingService's in-house auto-assign lookup did an exact
// (case-sensitive) baseCity match, while ServiceVendorsService.isEligibleForOrder's own
// fallback already normalizes both sides with .toLowerCase() — an inconsistency that could
// skip an in-house match purely over "Bhopal" vs "bhopal" casing.
describe('RoutingService.route — city match is case-insensitive', () => {
  function makeService() {
    const prisma: any = {
      order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
      orderTimeline: { create: jest.fn() },
    };
    const events: any = { emit: jest.fn() };
    const dispatch: any = { dispatch: jest.fn().mockResolvedValue([]) };
    return { service: new RoutingService(prisma, events, dispatch), prisma };
  }

  it('queries baseCity with mode: insensitive', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      service: { fulfillmentType: 'DIRECT_PARTNER', requiredSkills: [] },
      address: { city: 'bhopal' },
    });

    await service.route('order-1');

    const where = prisma.serviceVendor.findMany.mock.calls[0][0].where;
    expect(where.baseCity).toEqual({ equals: 'bhopal', mode: 'insensitive' });
  });
});
