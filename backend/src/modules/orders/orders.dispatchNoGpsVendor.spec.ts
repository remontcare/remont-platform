import { DispatchService } from './orders.module';

/**
 * Real production incident (found via a live end-to-end test, not just code review): a
 * verified, ACTIVE, online, correct-skill, same-city vendor never received an order whose
 * address had valid GPS coordinates, because that vendor had never sent a single location
 * ping (ServiceVendor.currentLatitude/Longitude were null — the app never called
 * PATCH .../me/location for them). dispatch() used to pick EITHER the GPS-radius branch OR
 * the city-text-fallback branch based only on whether the ORDER had valid coordinates — an
 * order with valid GPS always took the GPS-only branch, which structurally excludes every
 * vendor with no location fix, even ones in the exact right city. Fixed by making the two
 * candidate pools additive: real GPS-radius matches (scored by distance) PLUS same-city
 * vendors who simply have no usable GPS fix yet (scored by the city-fallback formula).
 */
function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    serviceVendor: { findMany: jest.fn() },
  };
  const events: any = { emit: jest.fn() };
  return { service: new DispatchService(prisma, events), prisma };
}

function bhopalWaterproofingOrder() {
  return {
    id: 'order-1', orderNumber: 'ORD-1',
    // Order has valid, real GPS (e.g. the city centroid from a guest booking) — this is
    // exactly what previously caused the GPS-only branch to run and exclude everyone
    // without a location fix.
    address: { latitude: 23.2599, longitude: 77.4126, city: 'Bhopal' },
    service: { category: { key: 'waterproofing' } },
  };
}

function noGpsVendor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vendor-mayank', userId: 'user-mayank', rating: 5, isVipPro: false, serviceRadius: 10,
    baseCity: 'Bhopal', skills: ['WATERPROOFING'],
    currentLatitude: null, currentLongitude: null, lastLocationUpdate: null,
    ...overrides,
  };
}

describe('DispatchService.dispatch — same-city vendor with no GPS fix is not silently excluded', () => {
  it('offers the job to a same-city vendor with null GPS even though the order itself has valid coordinates', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(bhopalWaterproofingOrder());
    prisma.serviceVendor.findMany
      .mockResolvedValueOnce([]) // GPS-radius pool: nobody with a fresh GPS fix
      .mockResolvedValueOnce([noGpsVendor()]); // same-city fallback pool: Mayank

    const offered = await service.dispatch('order-1');

    expect(offered.map((c: any) => c.vendorId)).toEqual(['vendor-mayank']);
  });

  it('the same-city fallback query explicitly excludes vendors who DO have a fresh GPS fix (avoids double-scoring)', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(bhopalWaterproofingOrder());
    prisma.serviceVendor.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.dispatch('order-1');

    const cityCallWhere = prisma.serviceVendor.findMany.mock.calls[1][0].where;
    expect(cityCallWhere.baseCity).toEqual({ equals: 'Bhopal', mode: 'insensitive' });
    expect(cityCallWhere.OR).toEqual(expect.arrayContaining([
      { currentLatitude: null },
      { currentLongitude: null },
      { lastLocationUpdate: null },
    ]));
  });

  it('a vendor found via real GPS-radius match is not duplicated by the additive city-fallback pool', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(bhopalWaterproofingOrder());
    const withGps = noGpsVendor({ currentLatitude: 23.26, currentLongitude: 77.41, lastLocationUpdate: new Date() });
    prisma.serviceVendor.findMany
      .mockResolvedValueOnce([withGps]) // GPS pool finds them for real
      .mockResolvedValueOnce([withGps]); // hypothetically also returned by the city query

    const offered = await service.dispatch('order-1');

    expect(offered).toHaveLength(1);
    expect(offered[0].vendorId).toBe('vendor-mayank');
    expect(offered[0].distance).not.toBeNull(); // scored via real distance, not the city-fallback formula
  });

  it('both pools combined: a nearer GPS-matched vendor outranks a same-city no-GPS vendor', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(bhopalWaterproofingOrder());
    const gpsVendor = { id: 'vendor-gps', userId: 'user-gps', rating: 4.0, isVipPro: false, serviceRadius: 15, currentLatitude: 23.265, currentLongitude: 77.42, lastLocationUpdate: new Date() };
    prisma.serviceVendor.findMany
      .mockResolvedValueOnce([gpsVendor])
      .mockResolvedValueOnce([noGpsVendor()]);

    const offered = await service.dispatch('order-1');

    expect(offered.map((c: any) => c.vendorId)).toEqual(['vendor-gps', 'vendor-mayank']);
  });
});
