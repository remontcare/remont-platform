import * as crypto from 'crypto';
import { PaymentsService } from './payments.module';

/**
 * Financial-integrity fix: the Razorpay webhook is the only guaranteed-delivery payment
 * confirmation channel (the explicit confirm-payment call depends on the customer's browser
 * round-tripping back, which doesn't always happen). Previously the webhook only flipped
 * PaymentTransaction.status to PAID for wallet top-ups and never triggered the actual
 * wallet/ledger credit — see WalletService.confirmTopup / WithdrawalService.confirmTopup for
 * the other half of this fix (the atomic creditedAt claim that makes emitting here safe even
 * when the explicit confirm call already credited).
 */
function makeService() {
  const prisma: any = {
    paymentTransaction: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  };
  const paymentNotify: any = {};
  const events: any = { emit: jest.fn() };
  const svc = new PaymentsService(prisma, paymentNotify, events);
  (svc as any).razorpayWebhookSecret = 'test-webhook-secret';
  return { svc, prisma, events };
}

function signedWebhook(secret: string, payload: object) {
  const rawBody = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('PaymentsService.handleWebhook — wallet top-up crediting safety net', () => {
  it('emits payment.customerWalletTopup.captured for an isWalletTopup transaction', async () => {
    const { svc, prisma, events } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-1', userId: 'user-1', amount: 500, orderId: null, isWalletTopup: true,
    });
    const { rawBody, signature } = signedWebhook('test-webhook-secret', {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_abc' } } },
    });

    await svc.handleWebhook(rawBody, signature);

    expect(events.emit).toHaveBeenCalledWith('payment.customerWalletTopup.captured', {
      paymentTransactionId: 'tx-1', userId: 'user-1', amount: 500,
    });
  });

  it('emits payment.vendorWalletTopup.captured for a VENDOR_WALLET_TOPUP-marked transaction', async () => {
    const { svc, prisma, events } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-2', userId: 'vendor-user-1', amount: 750, orderId: 'VENDOR_WALLET_TOPUP', isWalletTopup: false,
    });
    const { rawBody, signature } = signedWebhook('test-webhook-secret', {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_2', order_id: 'order_xyz' } } },
    });

    await svc.handleWebhook(rawBody, signature);

    expect(events.emit).toHaveBeenCalledWith('payment.vendorWalletTopup.captured', {
      paymentTransactionId: 'tx-2', userId: 'vendor-user-1', amount: 750,
    });
  });

  it('does not emit a wallet-topup event for a regular order payment', async () => {
    const { svc, prisma, events } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-3', userId: 'user-1', amount: 999, orderId: 'order-real-1', isWalletTopup: false,
    });
    const { rawBody, signature } = signedWebhook('test-webhook-secret', {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_3', order_id: 'order_real' } } },
    });

    await svc.handleWebhook(rawBody, signature);

    expect(events.emit).not.toHaveBeenCalledWith('payment.customerWalletTopup.captured', expect.anything());
    expect(events.emit).not.toHaveBeenCalledWith('payment.vendorWalletTopup.captured', expect.anything());
  });

  it('rejects a webhook with an invalid signature', async () => {
    const { svc } = makeService();
    await expect(svc.handleWebhook('{"event":"payment.captured"}', 'wrong-signature')).rejects.toThrow();
  });
});
