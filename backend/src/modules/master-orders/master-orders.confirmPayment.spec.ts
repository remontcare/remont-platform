import * as crypto from 'crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MasterOrdersService } from './master-orders.module';

/**
 * PAYMENT SECURITY FIX — same underpayment-bypass regression coverage as
 * orders-payment-flow.spec.ts's "OrdersService.confirmPayment" suite, applied to the
 * master-order/bundle checkout path. The extra risk here is blast radius: a successful
 * confirm cascades PAID/CONFIRMED and dispatch to every child order in one transaction, so
 * an underpaid confirmation must be rejected before that transaction (and any dispatch) ever
 * runs — see test M.
 */
function makeService() {
  const prisma: any = {
    masterOrder: { findUnique: jest.fn() },
    paymentTransaction: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const tx = {
        masterOrder: { update: jest.fn(async () => ({})) },
        order: { update: jest.fn(async () => ({})) },
        orderTimeline: { create: jest.fn(async () => ({})) },
      };
      return fn(tx);
    }),
  };
  const coupons: any = {};
  const memberships: any = {};
  const cities: any = {};
  const payments: any = { getVerifiedCapturedAmount: jest.fn() };
  const dispatch: any = { dispatch: jest.fn(async () => []) };
  const routing: any = { route: jest.fn(async () => {}) };
  const paymentNotify: any = { paymentSuccess: jest.fn(async () => {}) };
  const shipments: any = {};
  const logistics: any = {};
  const svc = new MasterOrdersService(prisma, coupons, memberships, cities, payments, dispatch, routing, paymentNotify, shipments, logistics);
  return { svc, prisma, payments, routing };
}

const SECRET = 'test-razorpay-secret';
function sign(gatewayOrderId: string, paymentId: string) {
  return crypto.createHmac('sha256', SECRET).update(`${gatewayOrderId}|${paymentId}`).digest('hex');
}
const gatewayOrderId = 'rzp_order_1';
const paymentId = 'pay_1';

function pendingMasterOrder(overrides: any = {}) {
  return {
    id: 'mo1', masterOrderNumber: 'MREM-1', customerId: 'cust-1', totalAmount: 5000, walletUsed: 0,
    status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', guestPhone: '9999999999',
    childOrders: [{ id: 'child-1', serviceId: 'svc-1', bundleDispatchDeferred: false, type: 'SERVICE' }],
    ...overrides,
  };
}

describe('MasterOrdersService.confirmPayment — PAYMENT SECURITY on the bundle/multi-order cascade', () => {
  beforeEach(() => { process.env.RAZORPAY_KEY_SECRET = SECRET; });

  // I. Master-order full payment → SUCCESS
  it('I. confirms, cascades PAID/CONFIRMED to every child, and dispatches when the captured amount covers the total', async () => {
    const { svc, prisma, payments, routing } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder());
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    payments.getVerifiedCapturedAmount.mockResolvedValue(5000);

    const sig = sign(gatewayOrderId, paymentId);
    await svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig, 'cust-1');

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(routing.route).toHaveBeenCalledWith('child-1');
  });

  // J. Master-order underpayment → REJECTED
  it('J. rejects when the captured amount is less than the master order total', async () => {
    const { svc, prisma, payments, routing } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder());
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    payments.getVerifiedCapturedAmount.mockResolvedValue(1); // attacker paid ₹1 against a ₹5,000 bundle

    const sig = sign(gatewayOrderId, paymentId);
    await expect(svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig, 'cust-1')).rejects.toThrow(BadRequestException);
    expect(routing.route).not.toHaveBeenCalled();
  });

  // K. Master-order invalid signature → REJECTED
  it('K. rejects an invalid signature before ever checking the captured amount', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder());

    await expect(svc.confirmPayment('mo1', paymentId, gatewayOrderId, 'bad-sig', 'cust-1')).rejects.toThrow(BadRequestException);
    expect(payments.getVerifiedCapturedAmount).not.toHaveBeenCalled();
  });

  // L. Master-order unauthorized access → REJECTED
  it('L. rejects a caller who is not the master order\'s own customer', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder({ customerId: 'cust-1' }));

    const sig = sign(gatewayOrderId, paymentId);
    await expect(svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig, 'someone-else')).rejects.toThrow(ForbiddenException);
    expect(payments.getVerifiedCapturedAmount).not.toHaveBeenCalled();
  });

  it('L2. the public/guest confirm-payment path (no callerUserId) is unaffected — still works with no login', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder());
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    payments.getVerifiedCapturedAmount.mockResolvedValue(5000);

    const sig = sign(gatewayOrderId, paymentId);
    await expect(svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig)).resolves.toBeDefined();
  });

  // M. Underpaid master-order must NOT dispatch child orders
  it('M. an underpaid confirmation never reaches the $transaction cascade or dispatches any child order', async () => {
    const { svc, prisma, payments, routing } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder({
      childOrders: [
        { id: 'child-1', serviceId: 'svc-1', bundleDispatchDeferred: false, type: 'SERVICE' },
        { id: 'child-2', serviceId: 'svc-2', bundleDispatchDeferred: false, type: 'SERVICE' },
      ],
    }));
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1' });
    payments.getVerifiedCapturedAmount.mockResolvedValue(50); // far short of the ₹5,000 total

    const sig = sign(gatewayOrderId, paymentId);
    await expect(svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig, 'cust-1')).rejects.toThrow(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(routing.route).not.toHaveBeenCalled();
  });

  it('is idempotent for an already-PAID master order — no re-verification, no duplicate cascade', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder({ paymentStatus: 'PAID', status: 'CONFIRMED' }));

    const sig = sign(gatewayOrderId, paymentId);
    const result: any = await svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig, 'cust-1');

    expect(result.paymentStatus).toBe('PAID');
    expect(payments.getVerifiedCapturedAmount).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when no PaymentTransaction links this gatewayOrderId to this master order', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.masterOrder.findUnique.mockResolvedValue(pendingMasterOrder());
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);

    const sig = sign(gatewayOrderId, paymentId);
    await expect(svc.confirmPayment('mo1', paymentId, gatewayOrderId, sig, 'cust-1')).rejects.toThrow(BadRequestException);
    expect(payments.getVerifiedCapturedAmount).not.toHaveBeenCalled();
  });
});
