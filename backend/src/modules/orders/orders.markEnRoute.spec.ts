import { OrdersService } from './orders.module';

/**
 * markEnRoute() previously had no FROM-status guard at all — the updateMany's WHERE only
 * checked ownership (vendorId), so calling POST /orders/:id/en-route on an already-STARTED,
 * COMPLETED, or CANCELLED order would silently revert its status back to VENDOR_EN_ROUTE,
 * corrupting the timeline and effectively re-opening a closed job. This asserts the fix: only
 * VENDOR_ASSIGNED -> VENDOR_EN_ROUTE (and a same-state retry) is allowed.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn() },
    order: { updateMany: jest.fn() },
  };
  prisma.orderTimeline = { create: jest.fn() };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}

describe('OrdersService.markEnRoute', () => {
  it('scopes the update to VENDOR_ASSIGNED/VENDOR_EN_ROUTE and this vendor only', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1' });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });

    await svc.markEnRoute('vendor-user-1', 'order-1');

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', vendorId: 'vendor-1', status: { in: ['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE'] } },
      data: { status: 'VENDOR_EN_ROUTE' },
    });
  });

  it('rejects when the order is not in a startable-navigation state (e.g. already COMPLETED)', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1' });
    // Real DB: WHERE status IN (...) matches nothing for a COMPLETED order.
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.markEnRoute('vendor-user-1', 'order-1')).rejects.toThrow();
    expect(prisma.orderTimeline.create).not.toHaveBeenCalled();
  });

  it('rejects when the order belongs to a different vendor (no ownership leak via count:0)', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1' });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.markEnRoute('vendor-user-1', 'someone-elses-order')).rejects.toThrow();
  });
});
