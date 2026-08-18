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
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any);
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

  it('still returns the vendor list for a real service order', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findMany.mockResolvedValue([{ id: 'vendor-1', memberStatus: null, isOnline: true, status: 'ACTIVE' }]);
    prisma.order.findUnique.mockResolvedValue({ serviceId: 'svc-1', address: null });

    const result = await svc.listActiveVendors(undefined, 'service-order-1');

    expect(result).toHaveLength(1);
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
