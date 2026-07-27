import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.module';

function makeService() {
  const prisma: any = {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: 'o1', ...args.data })),
    },
    serviceVendor: { findUnique: jest.fn() },
    paymentTransaction: {
      create: jest.fn(async (args: any) => ({ id: 'tx-1', ...args.data })),
      findFirst: jest.fn(),
      findMany: jest.fn(async () => []),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
      aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
    },
    user: { findUnique: jest.fn() },
  };
  // writeOrderTimeline (imported from ../../common) hits prisma.orderTimeline.create — stub it too.
  prisma.orderTimeline = { create: jest.fn() };
  const payments: any = {
    initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_order_1', keyId: 'rzp_test_key', txId: 'tx-1' })),
  };
  const dispatch: any = { dispatch: jest.fn(async () => {}) };
  const paymentNotify: any = {
    paymentSuccess: jest.fn(async () => {}),
    paymentFailed: jest.fn(async () => {}),
    balanceDue: jest.fn(async () => {}),
    workCompleted: jest.fn(async () => {}),
    payOnlineNudge: jest.fn(async () => {}),
  };
  const svc = new OrdersService(prisma, {} as any, {} as any, dispatch, {} as any, payments, paymentNotify);
  return { svc, prisma, payments, dispatch, paymentNotify };
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

describe('OrdersService.getBalance — recalculates automatically as extra work / partial payments change the total', () => {
  it('reports the full amount due when nothing has been paid yet', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 0, paymentStatus: 'PENDING' });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const b = await svc.getBalance('o1');
    expect(b.balanceDue).toBe(1000);
  });

  it('subtracts wallet-covered amount and prior PAID transactions from the total', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 200, paymentStatus: 'PARTIAL' });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 300 } });
    const b = await svc.getBalance('o1');
    expect(b.balanceDue).toBe(500);
  });

  it('reflects extra work automatically — totalAmount already includes it, no separate tracking needed', async () => {
    const { svc, prisma } = makeService();
    // Order.totalAmount was 1000, then ExtraWorkService.recalc() bumped it to 1300 after
    // ₹300 of approved extra work — getBalance needs no extra-work-specific logic at all.
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'REM-1', totalAmount: 1300, walletUsed: 0, paymentStatus: 'PARTIAL' });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });
    const b = await svc.getBalance('o1');
    expect(b.balanceDue).toBe(300);
  });

  it('never reports a negative balance', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 0, paymentStatus: 'PAID' });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 1200 } });
    const b = await svc.getBalance('o1');
    expect(b.balanceDue).toBe(0);
  });

  it('rejects a caller who is neither the customer, the assigned vendor, nor an admin', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 0, customerId: 'cust-1', vendor: { userId: 'vendor-user-a' },
    });
    await expect(svc.getBalance('o1', 'random-user', 'CUSTOMER' as any)).rejects.toThrow(ForbiddenException);
  });

  it('allows the order\'s own customer, the assigned vendor, and an admin', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 0, customerId: 'cust-1', vendor: { userId: 'vendor-user-a' },
    });
    await expect(svc.getBalance('o1', 'cust-1', 'CUSTOMER' as any)).resolves.toBeDefined();
    await expect(svc.getBalance('o1', 'vendor-user-a', 'SERVICE_VENDOR' as any)).resolves.toBeDefined();
    await expect(svc.getBalance('o1', 'anyone', 'ADMIN' as any)).resolves.toBeDefined();
  });
});

describe('OrdersService.collectBalance — Section 6/7 "Collect Payment" at completion / additional work', () => {
  it('rejects a vendor who is not assigned to the order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', status: 'COMPLETED', customerId: 'cust-1', totalAmount: 500, walletUsed: 0, vendor: { userId: 'vendor-user-a' },
    });
    await expect(svc.collectBalance('vendor-user-b', 'SERVICE_VENDOR' as any, 'o1', 'CASH' as any)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a random customer trying to collect cash on someone else\'s order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', status: 'COMPLETED', customerId: 'cust-1', totalAmount: 500, walletUsed: 0, vendor: { userId: 'vendor-user-a' },
    });
    await expect(svc.collectBalance('cust-1', 'CUSTOMER' as any, 'o1', 'CASH' as any)).rejects.toThrow(ForbiddenException);
  });

  it('allows the order\'s own customer to self-serve pay the remaining balance online', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', orderNumber: 'REM-1', status: 'COMPLETED', customerId: 'cust-1', totalAmount: 500, walletUsed: 0, vendor: { userId: 'vendor-user-a' },
    });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const result: any = await svc.collectBalance('cust-1', 'CUSTOMER' as any, 'o1', 'ONLINE' as any);
    expect(payments.initiatePayment).toHaveBeenCalledWith('cust-1', 500, 'o1', expect.any(String));
    expect(result.requiresPayment).toBe(true);
  });

  it('returns "nothing due" without creating a transaction when the balance is already zero', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', orderNumber: 'REM-1', status: 'COMPLETED', customerId: 'cust-1', totalAmount: 500, walletUsed: 0, vendor: { userId: 'vendor-user-a' },
    });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 500 } });
    const result: any = await svc.collectBalance('vendor-user-a', 'SERVICE_VENDOR' as any, 'o1', 'CASH' as any);
    expect(result.message).toMatch(/already fully paid/);
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it('records a cash collection for exactly the outstanding balance and marks the order PAID', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', orderNumber: 'REM-1', status: 'COMPLETED', customerId: 'cust-1', totalAmount: 800, walletUsed: 0, vendor: { userId: 'vendor-user-a' },
    });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 500 } });
    const result: any = await svc.collectBalance('vendor-user-a', 'SERVICE_VENDOR' as any, 'o1', 'UPI' as any, 'Site visit');
    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 300, collectionMode: 'UPI', collectedLocation: 'Site visit' }),
    }));
    expect(result.paymentStatus).toBe('PAID');
  });
});

describe('OrdersService.confirmBalancePayment — never moves order.status, only paymentStatus', () => {
  it('rejects an invalid signature', async () => {
    const { svc } = makeService();
    process.env.RAZORPAY_KEY_SECRET = 'test-secret';
    await expect(svc.confirmBalancePayment('o1', 'pay_1', 'order_1', 'bad-sig')).rejects.toThrow(BadRequestException);
  });

  it('sets paymentStatus PARTIAL when a balance remains after this payment', async () => {
    const { svc, prisma } = makeService();
    process.env.RAZORPAY_KEY_SECRET = 'test-secret';
    const crypto = require('crypto');
    const gatewayOrderId = 'order_1', paymentId = 'pay_1';
    const sig = crypto.createHmac('sha256', 'test-secret').update(`${gatewayOrderId}|${paymentId}`).digest('hex');
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PENDING' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 0 });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 400 } }); // still short of 1000
    const result = await svc.confirmBalancePayment('o1', paymentId, gatewayOrderId, sig);
    expect(prisma.paymentTransaction.update).toHaveBeenCalled();
    expect(result.paymentStatus).toBe('PARTIAL');
  });

  it('sets paymentStatus PAID once this payment fully covers the balance', async () => {
    const { svc, prisma } = makeService();
    process.env.RAZORPAY_KEY_SECRET = 'test-secret';
    const crypto = require('crypto');
    const gatewayOrderId = 'order_2', paymentId = 'pay_2';
    const sig = crypto.createHmac('sha256', 'test-secret').update(`${gatewayOrderId}|${paymentId}`).digest('hex');
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-2', status: 'PENDING' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'REM-1', totalAmount: 1000, walletUsed: 0 });
    prisma.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });
    const result = await svc.confirmBalancePayment('o1', paymentId, gatewayOrderId, sig);
    expect(result.paymentStatus).toBe('PAID');
  });
});

describe('OrdersService.getPaymentHistory — customer payment dashboard transaction list', () => {
  it('rejects a caller who is not the customer or the assigned vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a' } });
    await expect(svc.getPaymentHistory('random-user', 'o1')).rejects.toThrow(ForbiddenException);
  });

  it('returns only customer-safe fields — no gatewaySignature or raw gatewayResponse', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a' } });
    await svc.getPaymentHistory('cust-1', 'o1');
    expect(prisma.paymentTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId: 'o1' },
      select: expect.objectContaining({
        amount: true, status: true, gateway: true, collectionMode: true, createdAt: true,
      }),
    }));
    const selectArg = (prisma.paymentTransaction.findMany.mock.calls[0][0] as any).select;
    expect(selectArg.gatewaySignature).toBeUndefined();
    expect(selectArg.gatewayResponse).toBeUndefined();
    expect(selectArg.gatewayPaymentId).toBeUndefined();
  });
});
