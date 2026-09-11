import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.module';

/**
 * PAYMENT SECURITY FIX — regression coverage for the underpayment bypass: a genuine
 * Razorpay signature only proves *a* payment happened for a given (gatewayOrderId,
 * paymentId) pair, never that it covers what a specific order actually costs. These tests
 * cover the two independent trust boundaries this fix adds:
 *   1. PaymentsService.getVerifiedCapturedAmount() — re-derives the captured amount from
 *      Razorpay's own payment record, never from client input or our own stored
 *      PaymentTransaction.amount.
 *   2. PaymentsService.handleWebhook() — the same reconciliation applied to the webhook
 *      trigger, so the attack can't succeed purely via Razorpay's server-to-server
 *      callback either, without ever calling an explicit confirm-payment endpoint.
 * (OrdersService/MasterOrdersService's own use of getVerifiedCapturedAmount is covered in
 * orders-payment-flow.spec.ts and master-orders.confirmPayment.spec.ts.)
 */
function makeService() {
  const prisma: any = {
    paymentTransaction: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  };
  const paymentNotify: any = {};
  const events: any = { emit: jest.fn() };
  const svc = new PaymentsService(prisma, paymentNotify, events);
  (svc as any).razorpayWebhookSecret = 'test-webhook-secret';
  (svc as any).razorpay = { payments: { fetch: jest.fn() } };
  return { svc, prisma, events, razorpayFetch: (svc as any).razorpay.payments.fetch };
}

function signedWebhook(secret: string, payload: object) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('PaymentsService.getVerifiedCapturedAmount — re-verifies against Razorpay, never local data', () => {
  it('returns the captured amount (in rupees) when the payment matches the expected gateway order and is captured', async () => {
    const { svc, razorpayFetch } = makeService();
    razorpayFetch.mockResolvedValue({ order_id: 'rzp_order_1', status: 'captured', amount: 500000 });
    const amount = await svc.getVerifiedCapturedAmount('rzp_order_1', 'pay_1');
    expect(amount).toBe(5000);
    expect(razorpayFetch).toHaveBeenCalledWith('pay_1');
  });

  it('rejects when the payment belongs to a different Razorpay order than claimed', async () => {
    const { svc, razorpayFetch } = makeService();
    razorpayFetch.mockResolvedValue({ order_id: 'rzp_order_OTHER', status: 'captured', amount: 500000 });
    await expect(svc.getVerifiedCapturedAmount('rzp_order_1', 'pay_1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the payment has not actually been captured (e.g. only authorized)', async () => {
    const { svc, razorpayFetch } = makeService();
    razorpayFetch.mockResolvedValue({ order_id: 'rzp_order_1', status: 'authorized', amount: 500000 });
    await expect(svc.getVerifiedCapturedAmount('rzp_order_1', 'pay_1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects safely (no secrets/internals leaked) when the gateway lookup itself fails', async () => {
    const { svc, razorpayFetch } = makeService();
    razorpayFetch.mockRejectedValue(new Error('network timeout'));
    await expect(svc.getVerifiedCapturedAmount('rzp_order_1', 'pay_1')).rejects.toThrow('Unable to verify payment with the gateway');
  });

  it('rejects when Razorpay is not configured at all', async () => {
    const { svc } = makeService();
    (svc as any).razorpay = null;
    await expect(svc.getVerifiedCapturedAmount('rzp_order_1', 'pay_1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PaymentsService.handleWebhook — order marked PAID only when the captured amount covers its total', () => {
  it('marks the order PAID/CONFIRMED when the captured amount covers the order total', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-1', userId: 'user-1', orderId: 'order-1', isWalletTopup: false,
    });
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', paymentStatus: 'PENDING', status: 'PENDING_PAYMENT', totalAmount: 5000 });
    const { rawBody, signature } = signedWebhook('test-webhook-secret', {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1', amount: 500000 } } },
    });

    await svc.handleWebhook(rawBody, signature);

    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-1' },
      data: expect.objectContaining({ paymentStatus: 'PAID', status: 'CONFIRMED' }),
    }));
  });

  it('does NOT mark the order PAID when the captured amount is less than the order total — the core regression this fix closes', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-1', userId: 'user-1', orderId: 'order-1', isWalletTopup: false,
    });
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', paymentStatus: 'PENDING', status: 'PENDING_PAYMENT', totalAmount: 5000 });
    // Attacker's decoy: a genuinely-captured payment.captured webhook, but for ₹1 against a
    // ₹5,000 order — this must never flip the order to PAID.
    const { rawBody, signature } = signedWebhook('test-webhook-secret', {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_evil', order_id: 'rzp_order_evil', amount: 100 } } },
    });

    await svc.handleWebhook(rawBody, signature);

    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('still rejects an invalid webhook signature outright, before any amount reasoning', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.handleWebhook('{"event":"payment.captured"}', 'wrong-signature')).rejects.toThrow();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });
});
