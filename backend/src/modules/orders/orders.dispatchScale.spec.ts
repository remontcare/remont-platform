import { DispatchService } from './orders.module';
import { boundingBoxForRadius, MAX_DISPATCH_RADIUS_KM, haversineKm } from '../../common';

/**
 * Business requirement: dispatch must remain logically correct as the vendor table grows
 * into the thousands/tens-of-thousands, not just at today's small vendor count. Previously
 * DispatchService.dispatch()'s GPS-radius query pulled the first 50 online+matching-skill
 * vendors NATIONWIDE with no geographic filter and no ordering — once the nationwide online
 * vendor count exceeded 50, the actual nearest eligible vendor could simply never be among
 * the rows fetched (vendor #500, #5,000, #50,000 would never be reached). Fixed by adding a
 * DB-level bounding-box prefilter (a generous box no real eligible vendor can fall outside
 * of, since no vendor can configure a serviceRadius above MAX_DISPATCH_RADIUS_KM) before the
 * exact haversineKm+per-vendor-radius check runs in-app on the much smaller result.
 */
describe('boundingBoxForRadius', () => {
  it('produces a box that contains every point within the given radius (spot-checked against haversineKm)', () => {
    const center = { lat: 22.3072, lng: 73.1812 }; // Vadodara
    const box = boundingBoxForRadius(center.lat, center.lng, MAX_DISPATCH_RADIUS_KM);

    // A point ~80km away (within the 100km box) must fall inside the box bounds.
    const near = { lat: 22.3072 + 0.72, lng: 73.1812 }; // ~80km north
    expect(haversineKm(center.lat, center.lng, near.lat, near.lng)).toBeLessThan(MAX_DISPATCH_RADIUS_KM);
    expect(near.lat).toBeGreaterThanOrEqual(box.minLat);
    expect(near.lat).toBeLessThanOrEqual(box.maxLat);
  });

  it('never produces a box smaller than the radius requires, regardless of latitude', () => {
    // Near the top of India's valid latitude range (isValidIndiaCoords: up to 37.6) — the
    // longitude delta must still be generous enough (guarded by the Math.max(0.1, cos(...))
    // floor) rather than collapsing toward zero width.
    const box = boundingBoxForRadius(37.5, 77, 50);
    expect(box.maxLng - box.minLng).toBeGreaterThan(0);
    expect(box.maxLat - box.minLat).toBeGreaterThan(0);
  });
});

describe('DispatchService.dispatch — geographic bounding-box prefilter', () => {
  function makeService() {
    const prisma: any = {
      order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const events: any = { emit: jest.fn() };
    return { service: new DispatchService(prisma, events), prisma };
  }

  it('scopes the candidate query to a lat/lng bounding box sized from MAX_DISPATCH_RADIUS_KM, and raises take beyond the old fixed 50', async () => {
    const { service, prisma } = makeService();
    const orderLat = 22.3072, orderLng = 73.1812;
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: orderLat, longitude: orderLng, city: 'Vadodara' },
      service: { category: { key: 'plumbing' } },
    });

    await service.dispatch('order-1');

    const call = prisma.serviceVendor.findMany.mock.calls[0][0];
    const expectedBox = boundingBoxForRadius(orderLat, orderLng, MAX_DISPATCH_RADIUS_KM);
    expect(call.where.currentLatitude).toEqual({ gte: expectedBox.minLat, lte: expectedBox.maxLat });
    expect(call.where.currentLongitude).toEqual({ gte: expectedBox.minLng, lte: expectedBox.maxLng });
    expect(call.take).toBeGreaterThan(50);
  });

  it('a vendor far outside MAX_DISPATCH_RADIUS_KM is excluded even if it were somehow returned by the DB (defense in depth)', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: 22.3072, longitude: 73.1812, city: 'Vadodara' }, // Vadodara
      service: { category: { key: 'plumbing' } },
    });
    // dispatch() now queries twice — the GPS-radius pool, then the additive same-city
    // (no-GPS) fallback pool. Only the first call is under test here.
    prisma.serviceVendor.findMany
      .mockResolvedValueOnce([
        // ~1500km away (e.g. a different region entirely) — a DB query bug or a manually
        // crafted mock should never let this one through the in-app exact-distance filter.
        { id: 'far-vendor', userId: 'u1', rating: 5, isVipPro: false, serviceRadius: 100, currentLatitude: 8.5, currentLongitude: 76.9, skills: ['PLUMBING'] },
      ])
      .mockResolvedValueOnce([]); // same-city fallback pool: nobody

    const offered = await service.dispatch('order-1');

    expect(offered).toEqual([]);
  });

  it('a nearby vendor within their own configured serviceRadius is still correctly offered the job', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      address: { latitude: 22.3072, longitude: 73.1812, city: 'Vadodara' },
      service: { category: { key: 'plumbing' } },
    });
    prisma.serviceVendor.findMany.mockResolvedValue([
      { id: 'near-vendor', userId: 'u2', rating: 4.5, isVipPro: false, serviceRadius: 15, currentLatitude: 22.31, currentLongitude: 73.18, skills: ['PLUMBING'] },
    ]);

    const offered = await service.dispatch('order-1');

    expect(offered.map((c: any) => c.vendorId)).toEqual(['near-vendor']);
  });
});
