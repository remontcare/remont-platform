import { BadRequestException } from '@nestjs/common';
import { WalletService } from './wallet.module';

/**
 * Financial-integrity fix: WalletService.confirmTopup() used to treat
 * PaymentTransaction.status==='PAID' as "already credited" — but status is also written by
 * PaymentsService.handleWebhook independently of crediting, so a webhook racing ahead of this
 * explicit confirm call could mark a transaction PAID without ever crediting the wallet, and
 * this call would then see PAID and skip crediting too. Credit is now atomically claimed via
 * PaymentTransaction.creditedAt, shared between this method and the webhook's
 * onCustomerWalletTopupCaptured listener below — whichever fires first wins the credit.
 */
function makeService() {
  const prisma: any = {
    user: { update: jest.fn(async (args: any) => ({ walletBalance: 1500 })), findUnique: jest.fn().mockResolvedValue({ walletBalance: 1500 }) },
    walletTransaction: { create: jest.fn().mockResolvedValue({}) },
    paymentTransaction: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const payments: any = { verifyAndMarkPaid: jest.fn().mockResolvedValue(true) };
  const svc = new WalletService(prisma, payments);
  return { svc, prisma, payments };
}

describe('WalletService.confirmTopup', () => {
  it('rejects when no matching top-up payment record exists', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);
    await expect(svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'sig')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid signature and does not credit the wallet', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PENDING', amount: 500 });
    payments.verifyAndMarkPaid.mockResolvedValue(false);

    await expect(svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'bad-sig')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('credits the wallet via the atomic creditedAt claim after a verified payment', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PENDING', amount: 500 });

    await svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'good-sig');

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', creditedAt: null },
      data: { creditedAt: expect.any(Date) },
    });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' }, data: { walletBalance: { increment: 500 } },
    }));
  });

  it('does not double-credit when the creditedAt claim was already won (e.g. by the webhook)', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PAID', amount: 500 });
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });

    await svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'sig');

    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('WalletService.onCustomerWalletTopupCaptured (webhook safety net)', () => {
  it('credits the wallet when the webhook wins the creditedAt claim', async () => {
    const { svc, prisma } = makeService();

    await svc.onCustomerWalletTopupCaptured({ paymentTransactionId: 'tx-1', userId: 'user-1', amount: 500 });

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', creditedAt: null },
      data: { creditedAt: expect.any(Date) },
    });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' }, data: { walletBalance: { increment: 500 } },
    }));
  });

  it('does not double-credit when the explicit confirmTopup call already claimed it', async () => {
    const { svc, prisma } = makeService();
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });

    await svc.onCustomerWalletTopupCaptured({ paymentTransactionId: 'tx-1', userId: 'user-1', amount: 500 });

    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
