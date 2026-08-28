import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProductVendorsService } from './vendors.module';

/**
 * Phase 5 — seller accept/reject/process/ready-for-pickup stage transitions. Each transition
 * is a conditional updateMany claim lock (same idiom as ServiceVendorsService.acceptJob's
 * atomic status flip, see vendors.lead-cost.spec.ts) so a double-click or a stage-skip can
 * never both succeed.
 */
function makeService() {
  const prisma: any = {
    productVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'vendor-1', userId: 'user-1' }) },
    orderItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-1' }) },
    order: {
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'order-1', productFulfillmentStage: 'SELLER_ACCEPTED' }),
    },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
    returnShipment: { findUnique: jest.fn(), findMany: jest.fn() },
  };
  const shipments: any = { createShipmentForOrder: jest.fn().mockResolvedValue(undefined) };
  const returns: any = { listIncomingReturnsForVendor: jest.fn(), finalize: jest.fn() };
  const refunds: any = { raise: jest.fn(), decide: jest.fn() };
  const service = new ProductVendorsService(prisma, shipments, returns, refunds);
  return { service, prisma, shipments, returns, refunds };
}

describe('ProductVendorsService — product-order fulfillment stage transitions', () => {
  it('acceptOrder claims AWAITING_SELLER -> SELLER_ACCEPTED', async () => {
    const { service, prisma } = makeService();
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    await service.acceptOrder('user-1', 'order-1');
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', productFulfillmentStage: 'AWAITING_SELLER' },
      data: expect.objectContaining({ productFulfillmentStage: 'SELLER_ACCEPTED' }),
    });
  });

  it('rejects a double-accept (second concurrent claim loses the race)', async () => {
    const { service, prisma } = makeService();
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.acceptOrder('user-1', 'order-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects markReadyForPickup when the order is still AWAITING_SELLER (stage-skip)', async () => {
    const { service, prisma } = makeService();
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.markReadyForPickup('user-1', 'order-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('markReadyForPickup triggers ShipmentService.createShipmentForOrder on success', async () => {
    const { service, prisma, shipments } = makeService();
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    await service.markReadyForPickup('user-1', 'order-1');
    expect(shipments.createShipmentForOrder).toHaveBeenCalledWith('order-1');
  });

  it('rejectOrder auto-raises a wallet refund for an already-paid order', async () => {
    const { service, prisma, refunds } = makeService();
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', paymentStatus: 'PAID', totalAmount: 499,
    });
    refunds.raise.mockResolvedValue({ id: 'refund-1' });
    await service.rejectOrder('user-1', 'order-1', 'Out of stock');
    expect(refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.stringContaining('Out of stock'), []);
    expect(refunds.decide).toHaveBeenCalledWith('SYSTEM', 'refund-1', 'WALLET_CREDIT', expect.objectContaining({ approvedAmount: 499 }));
  });

  it('assertOwnsOrder blocks a seller acting on an order with none of their products', async () => {
    const { service, prisma } = makeService();
    prisma.orderItem.findFirst.mockResolvedValue(null);
    await expect(service.acceptOrder('user-1', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
