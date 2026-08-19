import { ServiceVendorsService } from './vendors.module';
import { VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } from '../../common';

/**
 * Full lifecycle audit finding: isEligibleForOrder()'s "order has no coords -> return true"
 * branch was dead code, because Address.latitude/longitude default to 0 (not null) — every
 * order missing a real GPS fix was instead run through haversineKm against (0,0) and silently
 * excluded from every vendor's "available jobs" list, even though DispatchService.dispatch()
 * (fixed alongside this) now correctly falls back to city-text matching for the same case.
 * Also covers the staleness inconsistency: dispatch() already excludes a vendor whose GPS
 * ping is >2h old; isEligibleForOrder() previously did not, so a vendor invisible to the
 * automatic offer wave could still self-claim the same job by browsing "available jobs".
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    order: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const whatsapp: any = { sendJobAssigned: jest.fn() };
  const events: any = { emit: jest.fn() };
  const ledger: any = { getLeadCostAmount: jest.fn().mockResolvedValue(0), postLeadCost: jest.fn() };
  return { service: new ServiceVendorsService(prisma, whatsapp, events, ledger), prisma };
}

function releasedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', vendorId: null, status: 'CONFIRMED', dispatchAttempts: 1,
    service: { category: { key: 'PLUMBING' }, fulfillmentType: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES[0] },
    address: { city: 'Bhopal', latitude: 0, longitude: 0 },
    ...overrides,
  };
}

describe('ServiceVendorsService.availableJobs — GPS fallback consistency', () => {
  it('falls back to city match (not excluded) when the order has no valid GPS and the vendor has a fresh GPS fix', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({
      id: 'vendor-1', status: 'ACTIVE', memberStatus: null, skills: ['PLUMBING'], baseCity: 'Bhopal',
      serviceRadius: 10, currentLatitude: 23.25, currentLongitude: 77.41, lastLocationUpdate: new Date(),
    });
    prisma.order.findMany.mockResolvedValue([releasedOrder({ address: { city: 'Bhopal', latitude: 0, longitude: 0 } })]);

    const jobs = await service.availableJobs('vendor-user-1');

    expect(jobs).toHaveLength(1);
  });

  it('excludes the order via city mismatch (not a (0,0)-distance false-exclude) when order has no valid GPS', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({
      id: 'vendor-1', status: 'ACTIVE', memberStatus: null, skills: ['PLUMBING'], baseCity: 'Indore',
      serviceRadius: 10, currentLatitude: 23.25, currentLongitude: 77.41, lastLocationUpdate: new Date(),
    });
    prisma.order.findMany.mockResolvedValue([releasedOrder({ address: { city: 'Bhopal', latitude: 0, longitude: 0 } })]);

    const jobs = await service.availableJobs('vendor-user-1');

    expect(jobs).toHaveLength(0);
  });

  it('falls back to city match when the vendor GPS fix is stale (>2h old), even though the order has valid coords', async () => {
    const { service, prisma } = makeService();
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago
    prisma.serviceVendor.findUnique.mockResolvedValue({
      id: 'vendor-1', status: 'ACTIVE', memberStatus: null, skills: ['PLUMBING'], baseCity: 'Bhopal',
      serviceRadius: 10, currentLatitude: 0, currentLongitude: 0, lastLocationUpdate: staleTime,
    });
    prisma.order.findMany.mockResolvedValue([releasedOrder({ address: { city: 'Bhopal', latitude: 23.25, longitude: 77.41 } })]);

    const jobs = await service.availableJobs('vendor-user-1');

    // Stale GPS -> ignored, falls back to city text match -> still eligible (same city)
    expect(jobs).toHaveLength(1);
  });

  it('uses real GPS-radius matching when both the vendor GPS is fresh and the order has valid coords', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({
      id: 'vendor-1', status: 'ACTIVE', memberStatus: null, skills: ['PLUMBING'], baseCity: 'Bhopal',
      serviceRadius: 5, currentLatitude: 23.9, currentLongitude: 78.1, lastLocationUpdate: new Date(), // far from the order
    });
    prisma.order.findMany.mockResolvedValue([releasedOrder({ address: { city: 'Bhopal', latitude: 23.25, longitude: 77.41 } })]);

    const jobs = await service.availableJobs('vendor-user-1');

    // Real coords on both sides, vendor is outside serviceRadius -> excluded by distance,
    // even though the city text would otherwise match.
    expect(jobs).toHaveLength(0);
  });
});
