import { DispatchRetryService } from './orders.module';

/**
 * DispatchRetryService re-cycles a fresh dispatch wave for orders whose last wave went
 * stale (over an hour, no vendor accepted). It must only ever touch genuinely
 * vendor-dispatchable orders — RoutingService never calls DispatchService.dispatch() for a
 * PROJECT/ADMIN_TEAM (in-house-planned) order in the first place (see
 * orders-payment-flow.spec.ts's "never auto-assign" tests), so lastDispatchedAt stays null
 * for those forever and the `lte` filter here structurally can never match a null column —
 * this test locks in the query shape that guarantee depends on.
 */
function makeService() {
  const prisma: any = { order: { findMany: jest.fn().mockResolvedValue([]) } };
  const dispatch: any = { dispatch: jest.fn(async () => {}) };
  const service = new DispatchRetryService(prisma, dispatch);
  return { service, prisma, dispatch };
}

describe('DispatchRetryService.sweep', () => {
  it('only queries confirmed, unassigned orders with a stale lastDispatchedAt', async () => {
    const { service, prisma } = makeService();

    await service.sweep();

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'CONFIRMED',
        vendorId: null,
        lastDispatchedAt: expect.objectContaining({ lte: expect.any(Date) }),
      }),
    }));
    // A never-dispatched in-house order has lastDispatchedAt = null, which a `lte`
    // comparison never matches in SQL — so it can never appear in `stale` below.
  });

  it('re-dispatches every stale order the query returns, and only those', async () => {
    const { service, prisma, dispatch } = makeService();
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-1', orderNumber: 'ORD-1' },
      { id: 'order-2', orderNumber: 'ORD-2' },
    ]);

    await service.sweep();

    expect(dispatch.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.dispatch).toHaveBeenCalledWith('order-1');
    expect(dispatch.dispatch).toHaveBeenCalledWith('order-2');
  });

  it('does nothing when no order is stale (e.g. only in-house orders are unassigned)', async () => {
    const { service, prisma, dispatch } = makeService();
    prisma.order.findMany.mockResolvedValue([]);

    await service.sweep();

    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('keeps sweeping remaining orders even if one re-dispatch throws', async () => {
    const { service, prisma, dispatch } = makeService();
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-1', orderNumber: 'ORD-1' },
      { id: 'order-2', orderNumber: 'ORD-2' },
    ]);
    dispatch.dispatch.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    await expect(service.sweep()).resolves.toBeUndefined();
    expect(dispatch.dispatch).toHaveBeenCalledTimes(2);
  });
});
