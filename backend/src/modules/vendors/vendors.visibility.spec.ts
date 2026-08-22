import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ServiceVendorsService } from './vendors.module';
import { VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } from '../../common';

/**
 * Vendor-visibility boundary for auto-dispatch: an order must be (a) unassigned,
 * (b) already released by at least one DispatchService wave (dispatchAttempts >= 1), and
 * (c) for a vendor-dispatchable Service.fulfillmentType (see VENDOR_DISPATCHABLE_FULFILLMENT_TYPES
 * in common/index.ts — an allowlist, so PROJECT/ADMIN_TEAM in-house-planned orders, and any
 * future in-house-only type, stay hidden by default). Both availableJobs() (the vendor
 * pull-list) and acceptJob() (the claim path) must enforce this identically and server-side,
 * so a vendor can never see or claim an order the admin queue owns.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    order: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
    $transaction: jest.fn(async (fn: any) => fn({
      order: prisma.order,
      serviceVendor: prisma.serviceVendor,
    })),
  };
  const whatsapp: any = { sendJobAssigned: jest.fn().mockResolvedValue(undefined) };
  const events: any = { emit: jest.fn() };
  const ledger: any = { getLeadCostAmount: jest.fn().mockResolvedValue(0), postLeadCost: jest.fn() };
  const service = new ServiceVendorsService(prisma, whatsapp, events, ledger);
  return { service, prisma, whatsapp, events, ledger };
}

function activeVendor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vendor-1', userId: 'vendor-user-1', status: 'ACTIVE', memberStatus: null,
    skills: ['PLUMBING'], baseCity: 'Bhopal', serviceRadius: 10,
    currentLatitude: null, currentLongitude: null,
    ...overrides,
  };
}

// A fully "released" order: dispatched at least once, vendor-dispatchable fulfillment type,
// matching skill/city — the baseline that every negative test mutates one field away from.
function releasedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', vendorId: null, status: 'CONFIRMED', dispatchAttempts: 1,
    service: { category: { key: 'PLUMBING' }, fulfillmentType: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES[0] },
    address: { city: 'Bhopal', latitude: null, longitude: null },
    ...overrides,
  };
}

describe('Vendor dispatch visibility boundary', () => {
  describe('availableJobs — DB-level query gate', () => {
    it('scopes the query to unassigned, confirmed, released, vendor-dispatchable orders — category/skill matching is NOT done at the DB level', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findMany.mockResolvedValue([]);

      await service.availableJobs('vendor-user-1');

      const call = prisma.order.findMany.mock.calls[0][0];
      expect(call.where).toEqual(expect.objectContaining({
        vendorId: null,
        status: 'CONFIRMED',
        dispatchAttempts: { gte: 1 },
        service: { fulfillmentType: { in: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } },
      }));
      // Production bug found via a live test: a DB-level `category: { key: { in: v.skills } } }`
      // filter compared ServiceCategory.key RAW against v.skills (always normalized), a
      // case-sensitive match that could never succeed — silently hiding every available job
      // from every vendor. Category/skill matching must live ONLY in isEligibleForOrder()
      // (asserted below), never duplicated here where it can drift out of sync again.
      expect(call.where.service.category).toBeUndefined();
      // ...and the category key must actually be fetched so isEligibleForOrder() has
      // something to normalize and compare in-app.
      expect(call.include.service.select.category).toEqual({ select: { key: true } });
    });

    it('returns a released, dispatchable, skill-matching order the query hands back', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findMany.mockResolvedValue([releasedOrder()]);

      const jobs = await service.availableJobs('vendor-user-1');

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('order-1');
    });

    // The exact bug: a category created with a lowercase key (e.g. seeded/typed as
    // "waterproofing") must still be found for a vendor whose skills are always normalized
    // uppercase ("WATERPROOFING") — this only works because the skill check now happens
    // in-app via isEligibleForOrder(), not as a case-sensitive DB array filter.
    it('matches a lowercase-keyed category against the vendor\'s normalized uppercase skill', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor({ skills: ['WATERPROOFING'], baseCity: 'Bhopal' }));
      prisma.order.findMany.mockResolvedValue([releasedOrder({
        service: { category: { key: 'waterproofing' }, fulfillmentType: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES[0] },
        address: { city: 'Bhopal', latitude: null, longitude: null },
      })]);

      const jobs = await service.availableJobs('vendor-user-1');

      expect(jobs).toHaveLength(1);
    });
  });

  describe('acceptJob — server-side re-check (defense in depth against a guessed/leaked orderId)', () => {
    it('rejects an in-house PROJECT order even though skill/city match', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findUnique.mockResolvedValue(releasedOrder({
        service: { category: { key: 'PLUMBING' }, fulfillmentType: 'PROJECT' },
      }));

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an in-house ADMIN_TEAM order even though skill/city match', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findUnique.mockResolvedValue(releasedOrder({
        service: { category: { key: 'PLUMBING' }, fulfillmentType: 'ADMIN_TEAM' },
      }));

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an order that has never been dispatched (dispatchAttempts = 0)', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findUnique.mockResolvedValue(releasedOrder({ dispatchAttempts: 0 }));

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('accepts a released, vendor-dispatchable order for an eligible vendor', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      const order = releasedOrder();
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...order, vendorId: 'vendor-1', status: 'VENDOR_ASSIGNED', customer: {} });

      await expect(service.acceptJob('vendor-user-1', 'order-1')).resolves.toMatchObject({ status: 'VENDOR_ASSIGNED' });
    });
  });

  describe('acceptJob — concurrent claim (two vendors accepting the same order at once)', () => {
    it('only the first of two simultaneous accept calls wins the atomic claim', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      const order = releasedOrder();
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue({ ...order, vendorId: 'vendor-1', status: 'VENDOR_ASSIGNED', customer: {} });
      // First updateMany call (vendor A) wins the compare-and-swap; the second (vendor B,
      // racing against the same still-CONFIRMED row) finds it already flipped and claims 0 rows.
      prisma.order.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const [first, second] = await Promise.allSettled([
        service.acceptJob('vendor-user-1', 'order-1'),
        service.acceptJob('vendor-user-2', 'order-1'),
      ]);

      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('rejected');
      if (second.status === 'rejected') {
        expect(second.reason).toBeInstanceOf(BadRequestException);
      }
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
    });
  });
});
