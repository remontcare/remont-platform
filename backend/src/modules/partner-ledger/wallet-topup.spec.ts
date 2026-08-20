import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WithdrawalService, PartnerLedgerService } from './partner-ledger.module';

/**
 * Vendor wallet "Add Money" — mirrors WalletService.initiateTopup()/confirmTopup()'s proven
 * pattern: create a real Razorpay order, verify the signature server-side, credit only after
 * verification, and stay idempotent if confirm is called twice (e.g. a duplicate webhook/
 * callback) for the same already-PAID transaction.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    paymentTransaction: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async (args: any) => args.data) },
    withdrawalRequest: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const ledger = new PartnerLedgerService(prisma);
  const payments: any = {
    initiatePayment: jest.fn().mockResolvedValue({ gateway: 'RAZORPAY', gatewayOrderId: 'order_abc', amount: 500, currency: 'INR', keyId: 'rzp_test_123', txId: 'tx-1' }),
    verifyAndMarkPaid: jest.fn().mockResolvedValue(true),
  };
  const svc = new WithdrawalService(prisma, ledger, payments);
  return { svc, prisma, ledger, payments };
}

describe('WithdrawalService.initiateTopup', () => {
  it('rejects a non-positive amount', async () => {
    const { svc } = makeService();
    await expect(svc.initiateTopup('user-1', 0, 'https://remont.in')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.initiateTopup('user-1', -10, 'https://remont.in')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s when the account has no vendor profile', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue(null);
    await expect(svc.initiateTopup('user-1', 500, 'https://remont.in')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a Razorpay order via PaymentsService and renames keyId to razorpayKeyId', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });

    const result = await svc.initiateTopup('user-1', 500, 'https://remont.in');

    expect(payments.initiatePayment).toHaveBeenCalledWith('user-1', 500, 'VENDOR_WALLET_TOPUP', 'https://remont.in');
    expect(result.razorpayKeyId).toBe('rzp_test_123');
    expect(result.gatewayOrderId).toBe('order_abc');
  });
});

describe('WithdrawalService.confirmTopup', () => {
  it('rejects when no matching top-up payment record exists', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);
    await expect(svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'sig')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid signature and does not credit the ledger', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PENDING', amount: 500 });
    payments.verifyAndMarkPaid.mockResolvedValue(false);

    await expect(svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'bad-sig')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.partnerLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('credits the ledger with a TOP_UP entry after a verified payment', async () => {
    const { svc, prisma, payments, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PENDING', amount: 500 });
    const postSpy = jest.spyOn(ledger, 'postEntry');

    await svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'good-sig');

    expect(payments.verifyAndMarkPaid).toHaveBeenCalledWith('order_abc', 'pay_1', 'good-sig');
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', creditedAt: null },
      data: { creditedAt: expect.any(Date) },
    });
    expect(postSpy).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'TOP_UP', 500, expect.objectContaining({ notes: expect.any(String) }));
    // Root cause of "wallet not updating on Partner Portal screen": pendingPayout is the
    // field ServiceVendorsService.earnings() actually reads for the displayed balance —
    // it must be kept in sync with the ledger credit, not just the ledger's own running total.
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({
      where: { id: 'vendor-1' }, data: { pendingPayout: { increment: 500 } },
    });
  });

  it('is idempotent — a second confirm call that loses the creditedAt claim does not double-credit', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', status: 'PAID', amount: 500 });
    // Real DB: the first confirm (or the webhook listener) already flipped creditedAt, so
    // this call's WHERE (creditedAt: null) matches nothing.
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });
    const postSpy = jest.spyOn(ledger, 'postEntry');

    await svc.confirmTopup('user-1', 'pay_1', 'order_abc', 'sig');

    expect(postSpy).not.toHaveBeenCalled();
    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
  });
});

describe('WithdrawalService.onVendorWalletTopupCaptured (webhook safety net)', () => {
  it('credits the ledger when the webhook wins the creditedAt claim', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });
    const postSpy = jest.spyOn(ledger, 'postEntry');

    await svc.onVendorWalletTopupCaptured({ paymentTransactionId: 'tx-1', userId: 'user-1', amount: 500 });

    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', creditedAt: null },
      data: { creditedAt: expect.any(Date) },
    });
    expect(postSpy).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'TOP_UP', 500, expect.objectContaining({ notes: expect.any(String) }));
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({
      where: { id: 'vendor-1' }, data: { pendingPayout: { increment: 500 } },
    });
  });

  it('does not double-credit when the explicit confirmTopup call already claimed it', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'user-1' });
    prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 }); // already claimed
    const postSpy = jest.spyOn(ledger, 'postEntry');

    await svc.onVendorWalletTopupCaptured({ paymentTransactionId: 'tx-1', userId: 'user-1', amount: 500 });

    expect(postSpy).not.toHaveBeenCalled();
    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
  });

  it('silently no-ops if the userId does not resolve to a vendor profile', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue(null);

    await expect(svc.onVendorWalletTopupCaptured({ paymentTransactionId: 'tx-1', userId: 'not-a-vendor', amount: 500 })).resolves.toBeUndefined();
    expect(prisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
  });
});
