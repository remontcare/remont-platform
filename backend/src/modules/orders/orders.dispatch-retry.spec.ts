import { DispatchRetryService } from './orders.module';
import { VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } from '../../common';

/**
 * DispatchRetryService re-cycles a fresh dispatch wave for orders whose last wave went
 * stale (over an hour, no vendor accepted) — and also for orders that somehow never got a
 * first wave at all (lastDispatchedAt: null), which happens for real: adding the
 * dispatchAttempts/lastDispatchedAt columns backfilled every pre-existing CONFIRMED,
 * unassigned order to dispatchAttempts:0/lastDispatchedAt:null, even ones that had already
 * been through the (pre-migration) dispatch flow. Without explicitly catching null here,
 * `lastDispatchedAt: { lte }` never matches NULL in SQL, so those orders would be
 * permanently invisible to this sweep — exactly what happened in production.
 *
 * Catching null must NOT catch PROJECT/ADMIN_TEAM (in-house) orders, which also have
 * lastDispatchedAt: null forever (RoutingService never calls dispatch() for them) — so the
 * query explicitly allowlists Service.fulfillmentType instead of relying on the null check
 * to keep them out.
 */
function makeService() {
  const prisma: any = { order: { findMany: jest.fn().mockResolvedValue([]) } };
  const dispatch: any = { dispatch: jest.fn(async () => {}) };
  const service = new DispatchRetryService(prisma, dispatch);
  return { service, prisma, dispatch };
}

describe('DispatchRetryService.sweep', () => {
  it('queries confirmed, unassigned, vendor-dispatchable orders that are stale OR never dispatched', async () => {
    const { service, prisma } = makeService();

    await service.sweep();

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'CONFIRMED',
        vendorId: null,
        service: { fulfillmentType: { in: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } },
        OR: [
          { lastDispatchedAt: null },
          { lastDispatchedAt: { lte: expect.any(Date) } },
        ],
      }),
    }));
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

  it('does nothing when the query returns no order (e.g. only in-house orders are unassigned)', async () => {
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
