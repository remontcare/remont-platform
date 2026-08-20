import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.module';
import { NOT_FROZEN_MEMBER_FILTER } from '../../common';

/**
 * Regression coverage for the same production incident as
 * orders/orders.dispatch-memberstatus.spec.ts: this endpoint backs the admin "live vendors,
 * assign directly" list, and a bare `memberStatus: { not: 'FROZEN' }` silently excludes every
 * non-agency vendor (memberStatus: null) — not just frozen ones — because NULL <> 'FROZEN' is
 * UNKNOWN under SQL's three-valued logic. Fixed via the shared NOT_FROZEN_MEMBER_FILTER.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findUnique: jest.fn(), update: jest.fn() },
    orderTimeline: { create: jest.fn().mockResolvedValue({}) },
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = {};
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any);
  return { svc, prisma, events };
}

describe('AdminService.listActiveVendors', () => {
  it('uses the null-safe NOT_FROZEN_MEMBER_FILTER, not a bare memberStatus:{not:FROZEN}', async () => {
    const { svc, prisma } = makeService();

    await svc.listActiveVendors('ELECTRICAL');

    expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isOnline: true, status: 'ACTIVE', ...NOT_FROZEN_MEMBER_FILTER }),
    }));
  });

  it('returns an online, active, skill-matching, non-agency (memberStatus: null) vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findMany.mockResolvedValue([
      { id: 'vendor-1', fullName: 'Rahul', memberStatus: null, isOnline: true, status: 'ACTIVE', skills: ['ELECTRICAL'] },
    ]);

    const result = await svc.listActiveVendors('ELECTRICAL');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('vendor-1');
  });

  // Regression: a product-only order has no service for a Service Partner to fulfil —
  // that belongs to the product's own ProductVendor/Seller instead. This is the one
  // vendor-assignment path (unlike RoutingService/DispatchService/availableJobs/acceptJob,
  // all of which already guard on order.service) that had no such check.
  it('returns [] for a product-only order (no serviceId), never a Service Partner list', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findMany.mockResolvedValue([{ id: 'vendor-1', memberStatus: null, isOnline: true, status: 'ACTIVE' }]);
    prisma.order.findUnique.mockResolvedValue({ serviceId: null, address: null });

    const result = await svc.listActiveVendors(undefined, 'product-order-1');

    expect(result).toEqual([]);
  });

  it('still returns the vendor list for a real service order with no resolvable category/address', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findMany.mockResolvedValue([{ id: 'vendor-1', memberStatus: null, isOnline: true, status: 'ACTIVE' }]);
    prisma.order.findUnique.mockResolvedValue({ serviceId: 'svc-1', address: null });

    const result = await svc.listActiveVendors(undefined, 'service-order-1');

    expect(result).toHaveLength(1);
  });

  // Production incident: a Vadodara Plumbing job's manual-assign list showed vendors from
  // every city and category — this endpoint never filtered on category (only sorted by
  // distance if an explicit `skill` param happened to be passed, which the admin frontend
  // never did) and never filtered on city/GPS eligibility at all, only display-sorted.
  describe('Vadodara Plumbing eligibility filtering', () => {
    function vadodaraPlumbingOrder(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1', serviceId: 'svc-plumbing',
        service: { category: { key: 'plumbing' } }, // stored lowercase, as an admin actually typed it
        address: { city: 'Vadodara', latitude: 22.3072, longitude: 73.1812 },
        ...overrides,
      };
    }

    it('derives the required skill from the order category and normalizes case before querying', async () => {
      const { svc, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue(vadodaraPlumbingOrder());

      await svc.listActiveVendors(undefined, 'order-1');

      expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ skills: { has: 'PLUMBING' } }),
      }));
    });

    it('includes a verified, live, correct-category, same-city Vadodara plumber', async () => {
      const { svc, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue(vadodaraPlumbingOrder());
      prisma.serviceVendor.findMany.mockResolvedValue([
        { id: 'vendor-vadodara-plumber', memberStatus: null, isOnline: true, status: 'ACTIVE', rating: 4.5, skills: ['PLUMBING'], baseCity: 'Vadodara', currentLatitude: null, currentLongitude: null, lastLocationUpdate: null },
      ]);

      const result = await svc.listActiveVendors(undefined, 'order-1');

      expect(result.map((v: any) => v.id)).toEqual(['vendor-vadodara-plumber']);
    });

    it('excludes a live, correct-category vendor from a different city (Bhopal) with no GPS overlap', async () => {
      const { svc, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue(vadodaraPlumbingOrder());
      prisma.serviceVendor.findMany.mockResolvedValue([
        { id: 'vendor-bhopal-plumber', memberStatus: null, isOnline: true, status: 'ACTIVE', rating: 4.9, skills: ['PLUMBING'], baseCity: 'Bhopal', currentLatitude: null, currentLongitude: null, lastLocationUpdate: null },
      ]);

      const result = await svc.listActiveVendors(undefined, 'order-1');

      expect(result).toEqual([]);
    });

    it('excludes a same-city vendor whose skills do not include the order category (Electrical for a Plumbing job)', async () => {
      const { svc, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue(vadodaraPlumbingOrder());
      // The DB query itself filters on skills:{has:'PLUMBING'} — an electrician never comes
      // back from serviceVendor.findMany in the first place for this order.
      prisma.serviceVendor.findMany.mockResolvedValue([]);

      const result = await svc.listActiveVendors(undefined, 'order-1');

      expect(result).toEqual([]);
      expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ skills: { has: 'PLUMBING' } }),
      }));
    });

    it('sorts eligible candidates nearest-first when the order has real GPS coordinates', async () => {
      const { svc, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue(vadodaraPlumbingOrder());
      prisma.serviceVendor.findMany.mockResolvedValue([
        { id: 'far', memberStatus: null, isOnline: true, status: 'ACTIVE', rating: 4.0, skills: ['PLUMBING'], baseCity: 'Vadodara', serviceRadius: 50, currentLatitude: 22.40, currentLongitude: 73.25, lastLocationUpdate: new Date() },
        { id: 'near', memberStatus: null, isOnline: true, status: 'ACTIVE', rating: 4.0, skills: ['PLUMBING'], baseCity: 'Vadodara', serviceRadius: 50, currentLatitude: 22.31, currentLongitude: 73.18, lastLocationUpdate: new Date() },
      ]);

      const result = await svc.listActiveVendors(undefined, 'order-1');

      expect(result.map((v: any) => v.id)).toEqual(['near', 'far']);
    });
  });
});

describe('AdminService.forceAssignVendor', () => {
  it('rejects assigning a Service Partner to a product-only order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ serviceId: null });

    await expect(svc.forceAssignVendor('product-order-1', 'vendor-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('404s for an order that does not exist', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(svc.forceAssignVendor('missing-order', 'vendor-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('assigns and notifies for a real service order', async () => {
    const { svc, prisma, events } = makeService();
    prisma.order.findUnique.mockResolvedValue({ serviceId: 'svc-1' });
    prisma.order.update.mockResolvedValue({
      id: 'service-order-1', vendor: { userId: 'vendor-user-1' },
    });

    await svc.forceAssignVendor('service-order-1', 'vendor-1');

    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'service-order-1' },
      data: { vendorId: 'vendor-1', status: 'VENDOR_ASSIGNED' },
    }));
    expect(events.emit).toHaveBeenCalledWith('job.offer.created', expect.objectContaining({ vendorUserId: 'vendor-user-1', orderId: 'service-order-1' }));
  });
});
