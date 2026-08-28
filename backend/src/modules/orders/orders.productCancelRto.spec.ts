import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.module';

/**
 * Phase 6 — a PRODUCT order's cancellation depends on the physical shipment stage: plain
 * cancel before pickup (SERVICE behaviour untouched), RTO after pickup, blocked once delivered.
 */
function makeService(orderOverrides: any) {
  const order = {
    id: 'order-1', orderNumber: 'REM-1', customerId: 'cust-1', type: 'PRODUCT', status: 'CONFIRMED',
    vendorId: null, leadCostAmount: 0, items: [{ id: 'item-1' }],
    ...orderOverrides,
  };
  const prisma: any = {
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      findUniqueOrThrow: jest.fn().mockResolvedValue(order),
    },
    $transaction: jest.fn(async (fn: any) => fn({ order: prisma.order, serviceVendor: { update: jest.fn() } })),
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
  };
  const returns: any = { initiateRto: jest.fn().mockResolvedValue(undefined) };
  const ledger: any = { refundLeadCost: jest.fn() };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, ledger, {} as any, returns);
  return { svc, prisma, returns, order };
}

describe('OrdersService.cancel — Phase 6 product/shipment-stage awareness', () => {
  it('a product order with no shipment yet falls through to a plain cancel', async () => {
    const { svc, prisma, returns } = makeService({ shipment: null });
    prisma.order.update = jest.fn().mockResolvedValue({ status: 'CANCELLED' });
    await svc.cancel('cust-1', 'order-1', 'Changed my mind');
    expect(returns.initiateRto).not.toHaveBeenCalled();
  });

  it('a product order whose shipment is already PICKED_UP triggers RTO instead of a plain cancel', async () => {
    const { svc, returns } = makeService({ shipment: { id: 'ship-1', status: 'PICKED_UP' } });
    await svc.cancel('cust-1', 'order-1', 'Changed my mind');
    expect(returns.initiateRto).toHaveBeenCalledWith({ id: 'order-1', orderNumber: 'REM-1' }, 'ship-1', 'cust-1', 'Changed my mind');
  });

  it('a product order whose shipment is IN_TRANSIT also triggers RTO', async () => {
    const { svc, returns } = makeService({ shipment: { id: 'ship-1', status: 'IN_TRANSIT' } });
    await svc.cancel('cust-1', 'order-1', 'reason');
    expect(returns.initiateRto).toHaveBeenCalled();
  });

  it('a delivered product order can no longer be cancelled — must raise a return instead', async () => {
    const { svc } = makeService({ shipment: { id: 'ship-1', status: 'DELIVERED' } });
    await expect(svc.cancel('cust-1', 'order-1', 'reason')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a COMPLETED product order can no longer be cancelled', async () => {
    const { svc } = makeService({ status: 'COMPLETED', shipment: { id: 'ship-1', status: 'DELIVERED' } });
    await expect(svc.cancel('cust-1', 'order-1', 'reason')).rejects.toBeInstanceOf(BadRequestException);
  });
});
