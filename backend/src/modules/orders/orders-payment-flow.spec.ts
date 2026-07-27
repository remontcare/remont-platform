import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.module';

function makeService() {
  const prisma: any = {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: 'o1', ...args.data })),
    },
    serviceVendor: { findUnique: jest.fn() },
    paymentTransaction: { create: jest.fn(async (args: any) => ({ id: 'tx-1', ...args.data })) },
    user: { findUnique: jest.fn() },
  };
  // writeOrderTimeline (imported from ../../common) hits prisma.orderTimeline.create — stub it too.
  prisma.orderTimeline = { create: jest.fn() };
  const payments: any = {
    initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_order_1', keyId: 'rzp_test_key', txId: 'tx-1' })),
  };
  const dispatch: any = { dispatch: jest.fn(async () => {}) };
  const svc = new OrdersService(prisma, {} as any, {} as any, dispatch, {} as any, payments);
  return { svc, prisma, payments, dispatch };
}

describe('OrdersService.retryPayment — retry/COD-to-Online conversion without duplicate bookings', () => {
  it('rejects when the phone does not match the order (guest orders have no JWT to check instead)', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', guestPhone: '9999999999', paymentStatus: 'PENDING', status: 'PENDING_PAYMENT',
      customerId: 'u1', totalAmount: 500, orderNumber: 'REM-1',
    });
    await expect(svc.retryPayment('o1', '8888888888')).rejects.toThrow(ForbiddenException);
  });

  it('rejects an already-paid order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', guestPhone: '9999999999', paymentStatus: 'PAID', status: 'CONFIRMED',
      customerId: 'u1', totalAmount: 500, orderNumber: 'REM-1',
    });
    await expect(svc.retryPayment('o1', '9999999999')).rejects.toThrow(BadRequestException);
  });

  it('rejects once the job has started — payment method can no longer change at that point', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', guestPhone: '9999999999', paymentStatus: 'PENDING', status: 'STARTED',
      customerId: 'u1', totalAmount: 500, orderNumber: 'REM-1',
    });
    await expect(svc.retryPayment('o1', '9999999999')).rejects.toThrow(BadRequestException);
  });

  it('re-initiates a fresh gateway order without creating or mutating the booking itself', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', guestPhone: '9999999999', paymentStatus: 'PENDING', status: 'CONFIRMED',
      customerId: 'u1', totalAmount: 500, orderNumber: 'REM-1',
    });
    const result = await svc.retryPayment('o1', '9999999999');
    expect(payments.initiatePayment).toHaveBeenCalledWith('u1', 500, 'o1', expect.any(String));
    expect(result.orderId).toBe('o1');
    expect(result.gatewayOrderId).toBe('rzp_order_1');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('allows COD-to-Online conversion while a vendor is assigned or en route, not just before assignment', async () => {
    const { svc, prisma } = makeService();
    for (const status of ['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE']) {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1', guestPhone: '9999999999', paymentStatus: 'PENDING', status,
        customerId: 'u1', totalAmount: 500, orderNumber: 'REM-1',
      });
      await expect(svc.retryPayment('o1', '9999999999')).resolves.toBeDefined();
    }
  });
});

describe('OrdersService.switchToCod — "Change Payment Method" after a failed Online payment', () => {
  it('rejects once the order is already paid', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', guestPhone: '9999999999', paymentStatus: 'PAID', status: 'CONFIRMED' });
    await expect(svc.switchToCod('o1', '9999999999')).rejects.toThrow(BadRequestException);
  });

  it('rejects once the order has moved past PENDING_PAYMENT some other way', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', guestPhone: '9999999999', paymentStatus: 'PENDING', status: 'CONFIRMED' });
    await expect(svc.switchToCod('o1', '9999999999')).rejects.toThrow(BadRequestException);
  });

  it('confirms the order as COD and dispatches, mirroring the initial COD booking path', async () => {
    const { svc, prisma, dispatch } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', guestPhone: '9999999999', paymentStatus: 'PENDING', status: 'PENDING_PAYMENT', serviceId: 'svc-1',
    });
    prisma.order.update.mockImplementation(async (args: any) => ({ id: 'o1', serviceId: 'svc-1', ...args.data }));
    const result = await svc.switchToCod('o1', '9999999999');
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'CONFIRMED', paymentMethod: 'COD' },
    }));
    expect(result.status).toBe('CONFIRMED');
    expect(dispatch.dispatch).toHaveBeenCalledWith('o1');
  });
});

describe('OrdersService.collectCod — closing the "COD paymentStatus stuck PENDING forever" gap', () => {
  it('rejects an order that was actually paid online', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', paymentMethod: 'ONLINE', paymentStatus: 'PENDING', status: 'CONFIRMED' });
    await expect(svc.collectCod('admin-1', 'ADMIN' as any, 'o1', 'CASH' as any)).rejects.toThrow(BadRequestException);
  });

  it('is idempotent once already marked paid — no duplicate PaymentTransaction', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', paymentMethod: 'COD', paymentStatus: 'PAID', status: 'COMPLETED' });
    const result = await svc.collectCod('admin-1', 'ADMIN' as any, 'o1', 'CASH' as any);
    expect(result.paymentStatus).toBe('PAID');
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects a vendor collecting payment for an order they are not assigned to', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', paymentMethod: 'COD', paymentStatus: 'PENDING', status: 'COMPLETED', vendorId: 'vendor-a' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-b' });
    await expect(svc.collectCod('user-b', 'SERVICE_VENDOR' as any, 'o1', 'CASH' as any)).rejects.toThrow(ForbiddenException);
  });

  it('records a PaymentTransaction with collection details and flips paymentStatus to PAID', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', paymentMethod: 'COD', paymentStatus: 'PENDING', status: 'COMPLETED',
      vendorId: 'vendor-a', customerId: 'cust-1', totalAmount: 800, orderNumber: 'REM-1',
    });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-a' });
    const result = await svc.collectCod('vendor-user-1', 'SERVICE_VENDOR' as any, 'o1', 'CASH' as any, 'Customer doorstep');
    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ collectionMode: 'CASH', collectedBy: 'vendor-user-1', collectedLocation: 'Customer doorstep' }),
    }));
    expect(result.paymentStatus).toBe('PAID');
  });
});
