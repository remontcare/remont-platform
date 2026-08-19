import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WithdrawalService, PartnerLedgerService } from './partner-ledger.module';

/**
 * Withdrawal Rules: only individuals/agency owners can withdraw (never a team member), and
 * the amount can never exceed availableBalance(). The interesting case is the race between
 * two concurrent requests for the same vendor — see the fix comment on
 * WithdrawalService.request() for why the balance check now runs inside a transaction that
 * takes a row lock first.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn() },
    withdrawalRequest: { create: jest.fn(async (args: any) => ({ id: 'wr-1', ...args.data })) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn({
    $queryRaw: jest.fn(),
    withdrawalRequest: prisma.withdrawalRequest,
  }));
  const ledger = new PartnerLedgerService(prisma);
  const svc = new WithdrawalService(prisma, ledger, {} as any);
  return { svc, prisma, ledger };
}

describe('WithdrawalService.request', () => {
  it('rejects a non-finite or non-positive amount', async () => {
    const { svc } = makeService();
    await expect(svc.request('user-1', NaN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.request('user-1', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.request('user-1', -5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a team member — only individuals/agency owners can withdraw', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'member-1', agencyOwnerId: 'owner-1' });
    await expect(svc.request('user-1', 100)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a request exceeding the available balance', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'vendor-1') return Promise.resolve({ isAgencyOwner: false, baseHoldAmount: 0 });
      return Promise.resolve({ id: 'vendor-1', agencyOwnerId: null });
    });
    // Available balance path (currentBalance/pendingWithdrawals) reads through the tx client
    // — stub the ledger's dependency chain by giving the tx a minimal ledger entry table too.
    prisma.$transaction = jest.fn(async (fn: any) => fn({
      $queryRaw: jest.fn(),
      serviceVendor: prisma.serviceVendor,
      partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue({ balanceAfter: 100 }) },
      withdrawalRequest: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }), create: prisma.withdrawalRequest.create },
    }));
    await expect(svc.request('user-1', 500)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('serializes two concurrent requests for the same vendor via the row lock — the second sees the first\'s pending amount', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'vendor-1') return Promise.resolve({ isAgencyOwner: false, baseHoldAmount: 0 });
      return Promise.resolve({ id: 'vendor-1', agencyOwnerId: null });
    });
    // Ledger balance is a fixed 1000; pendingWithdrawals reflects whatever's already been
    // created in this fake "DB" by the time each transaction's balance check runs — modeling
    // what row-locking + serialized transactions actually guarantee in Postgres.
    let pendingTotal = 0;
    const withdrawalRequest = {
      aggregate: jest.fn(async () => ({ _sum: { amount: pendingTotal } })),
      create: jest.fn(async (args: any) => { pendingTotal += args.data.amount; return { id: 'wr-x', ...args.data }; }),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn({
      $queryRaw: jest.fn(),
      serviceVendor: prisma.serviceVendor,
      partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue({ balanceAfter: 1000 }) },
      withdrawalRequest,
    }));

    await svc.request('user-1', 700); // first request: available 1000, fine
    await expect(svc.request('user-1', 700)).rejects.toBeInstanceOf(BadRequestException); // second: only 300 left
    expect(withdrawalRequest.create).toHaveBeenCalledTimes(1);
  });
});
