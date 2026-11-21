import * as crypto from 'crypto';
import { PaymentsService, hmacMatches } from './payments.module';

/**
 * Payment-sync hardening: a payment Razorpay captured for an order whose PaymentTransaction is
 * missing (its create step failed — the REM-1794750210856-581064 incident) used to be ignored
 * silently and marked processed, leaving a paid order unpaid (and eligible for auto-cancel).
 * It is now rebuilt from the Razorpay order's own notes, and only for the order + owner those
 * notes name; anything unrecoverable stays unprocessed for retry and is logged CRITICAL.
 */
const SECRET = 'whsec_test';

function makeService(opts: { order?: any; masterOrder?: any; rzpOrder?: any; existingTx?: any } = {}) {
  const prisma: any = {
    paymentTransaction: {
      findFirst: jest.fn().mockResolvedValue(opts.existingTx ?? null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tx-recovered', isWalletTopup: false, ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    order: { findUnique: jest.fn().mockResolvedValue(opts.order ?? null) },
    masterOrder: { findUnique: jest.fn().mockResolvedValue(opts.masterOrder ?? null) },
    paymentWebhookEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const events: any = { emit: jest.fn(), emitAsync: jest.fn() };
  const svc = new PaymentsService(prisma, {} as any, events);
  (svc as any).razorpayWebhookSecret = SECRET;
  (svc as any).razorpay = { orders: { fetch: jest.fn().mockResolvedValue(opts.rzpOrder ?? null) } };
  return { svc, prisma, events };
}

const captured = (orderId = 'order_rzp1', amountPaise = 1062) => {
  const rawBody = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: orderId, amount: amountPaise } } } });
  return { rawBody, signature: crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex') };
};

describe('hmacMatches', () => {
  const good = crypto.createHmac('sha256', 'k').update('x').digest('hex');
  it('accepts only the exact digest', () => {
    expect(hmacMatches(good, good)).toBe(true);
    expect(hmacMatches(good, good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a'))).toBe(false);
    expect(hmacMatches(good, good.slice(1))).toBe(false);
    expect(hmacMatches(good, undefined)).toBe(false);
    expect(hmacMatches(good, 42)).toBe(false);
  });
});

describe('PaymentsService webhook — missing PaymentTransaction recovery', () => {
  it('rebuilds the transaction from the Razorpay order notes and confirms through the normal event', async () => {
    const { svc, prisma, events } = makeService({
      masterOrder: { customerId: 'cust-1' },
      rzpOrder: { id: 'order_rzp1', amount: 1062, notes: { orderId: 'mo-1', userId: 'cust-1' } },
    });
    const { rawBody, signature } = captured();
    await svc.handleWebhook(rawBody, signature, 'evt_1');

    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      orderId: 'mo-1', masterOrderId: 'mo-1', userId: 'cust-1', amount: 10.62, status: 'PENDING', gateway: 'RAZORPAY', gatewayOrderId: 'order_rzp1',
    }) });
    expect(prisma.paymentTransaction.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', gatewayPaymentId: 'pay_1' }) }));
    // confirmation itself stays with the verified once-only listener (re-checks the captured amount)
    expect(events.emit).toHaveBeenCalledWith('payment.order.captured', { paymentTransactionId: 'tx-recovered', orderId: 'mo-1', gatewayPaymentId: 'pay_1' });
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalledWith({ where: { eventId: 'evt_1' }, data: { processedAt: expect.any(Date) } });
  });

  it('never attaches a payment to an order owned by someone other than the user in the notes', async () => {
    const { svc, prisma, events } = makeService({
      order: { customerId: 'someone-else' },
      rzpOrder: { id: 'order_rzp1', amount: 1062, notes: { orderId: 'o-1', userId: 'cust-1' } },
    });
    const { rawBody, signature } = captured();
    await svc.handleWebhook(rawBody, signature, 'evt_2');
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(prisma.paymentWebhookEvent.update).not.toHaveBeenCalled(); // left for retry + manual reconcile
  });

  it('does not recover wallet top-ups, AMC payments, or orders whose notes are missing', async () => {
    for (const notes of [{ orderId: 'WALLET_TOPUP', userId: 'u' }, { orderId: 'VENDOR_WALLET_TOPUP', userId: 'u' }, { orderId: 'o-1', userId: 'u', amcSubscriptionId: 'amc' }, {}]) {
      const { svc, prisma } = makeService({ order: { customerId: 'u' }, rzpOrder: { id: 'order_rzp1', amount: 500, notes } });
      const { rawBody, signature } = captured();
      await svc.handleWebhook(rawBody, signature, 'evt_x');
      expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
    }
  });

  it('a callback for a specific order only recovers when the notes name that exact order', async () => {
    const { svc, prisma } = makeService({
      order: { customerId: 'cust-1' },
      rzpOrder: { id: 'order_rzp1', amount: 1062, notes: { orderId: 'o-1', userId: 'cust-1' } },
    });
    expect(await svc.recoverTransactionFromGateway('order_rzp1', 'o-OTHER')).toBeNull();
    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
    const tx = await svc.recoverTransactionFromGateway('order_rzp1', 'o-1');
    expect(tx).toEqual(expect.objectContaining({ orderId: 'o-1', masterOrderId: undefined, amount: 10.62 }));
  });

  it('leaves the existing-transaction path unchanged (no gateway lookup)', async () => {
    const { svc, prisma, events } = makeService({ existingTx: { id: 'tx-1', userId: 'cust-1', amount: 999, orderId: 'o-1', isWalletTopup: false } });
    const { rawBody, signature } = captured();
    await svc.handleWebhook(rawBody, signature, 'evt_3');
    expect((svc as any).razorpay.orders.fetch).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('payment.order.captured', { paymentTransactionId: 'tx-1', orderId: 'o-1', gatewayPaymentId: 'pay_1' });
    expect(prisma.paymentWebhookEvent.update).toHaveBeenCalled();
  });

  it('a Razorpay lookup failure is not fatal and leaves the event for retry', async () => {
    const { svc, prisma } = makeService();
    (svc as any).razorpay.orders.fetch.mockRejectedValue(new Error('network'));
    const { rawBody, signature } = captured();
    await expect(svc.handleWebhook(rawBody, signature, 'evt_4')).resolves.toEqual({ received: true });
    expect(prisma.paymentWebhookEvent.update).not.toHaveBeenCalled();
  });
});
