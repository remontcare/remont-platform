import { BadRequestException } from '@nestjs/common';
import { WithdrawalService, PartnerLedgerService } from './partner-ledger.module';

/**
 * GET /vendors/wallet/available must report exactly the figure WithdrawalService.request()
 * validates against — the app displays it and uses it for "Withdraw full balance" instead of
 * re-deriving it from pendingPayout. Driven through the real PartnerLedgerService against a
 * small in-memory prisma fake.
 */
type V = { id: string; userId: string; balance: number; baseHold?: number; isAgencyOwner?: boolean; agencyOwnerId?: string | null };

function makeWorld(vendors: V[], pending: { vendorId: string; amount: number }[] = []) {
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const prisma: any = {
    serviceVendor: {
      findUnique: jest.fn(async ({ where }: any) => {
        const v = where.userId ? vendors.find((x) => x.userId === where.userId) : byId.get(where.id);
        return v ? { id: v.id, agencyOwnerId: v.agencyOwnerId ?? null, isAgencyOwner: !!v.isAgencyOwner, baseHoldAmount: v.baseHold ?? 0 } : null;
      }),
      findMany: jest.fn(async ({ where }: any) => vendors.filter((v) => v.agencyOwnerId === where.agencyOwnerId).map((v) => ({ id: v.id }))),
    },
    partnerLedgerEntry: {
      findFirst: jest.fn(async ({ where }: any) => ({ balanceAfter: byId.get(where.vendorId)?.balance ?? 0 })),
    },
    withdrawalRequest: {
      aggregate: jest.fn(async ({ where }: any) => {
        const ids: string[] = where.vendorId.in;
        const sum = pending.filter((p) => ids.includes(p.vendorId)).reduce((s, p) => s + p.amount, 0);
        return { _sum: { amount: sum || null } };
      }),
      create: jest.fn(async (args: any) => ({ id: 'wr-new', ...args.data })),
    },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const ledger = new PartnerLedgerService(prisma);
  return { svc: new WithdrawalService(prisma, ledger, {} as any), prisma };
}

describe('WithdrawalService.myAvailable (GET /vendors/wallet/available)', () => {
  it('normal balance', async () => {
    const { svc } = makeWorld([{ id: 'v1', userId: 'u1', balance: 1234.56 }]);
    await expect(svc.myAvailable('u1')).resolves.toEqual({ available: 1234.56, canWithdraw: true });
  });

  it('subtracts a pending withdrawal', async () => {
    const { svc } = makeWorld([{ id: 'v1', userId: 'u1', balance: 1000 }], [{ vendorId: 'v1', amount: 300 }]);
    await expect(svc.myAvailable('u1')).resolves.toEqual({ available: 700, canWithdraw: true });
  });

  it('keeps the base hold back', async () => {
    const { svc } = makeWorld([{ id: 'v1', userId: 'u1', balance: 1500, baseHold: 1000 }]);
    await expect(svc.myAvailable('u1')).resolves.toEqual({ available: 500, canWithdraw: true });
  });

  it('pools team balances for an agency owner (each member floored at their own base hold)', async () => {
    const { svc } = makeWorld(
      [
        { id: 'own', userId: 'u-own', balance: 400, isAgencyOwner: true },
        { id: 'm1', userId: 'u-m1', balance: 900, baseHold: 500, agencyOwnerId: 'own' }, // 400 usable
        { id: 'm2', userId: 'u-m2', balance: 100, baseHold: 500, agencyOwnerId: 'own' }, // 0, never negative
      ],
      [{ vendorId: 'm1', amount: 50 }],
    );
    await expect(svc.myAvailable('u-own')).resolves.toEqual({ available: 750, canWithdraw: true });
  });

  it('team member cannot withdraw — reports 0', async () => {
    const { svc } = makeWorld([
      { id: 'own', userId: 'u-own', balance: 0, isAgencyOwner: true },
      { id: 'm1', userId: 'u-m1', balance: 900, agencyOwnerId: 'own' },
    ]);
    await expect(svc.myAvailable('u-m1')).resolves.toEqual({ available: 0, canWithdraw: false });
  });

  it('zero (and never negative) balance', async () => {
    const { svc } = makeWorld([{ id: 'v1', userId: 'u1', balance: 200, baseHold: 1000 }]);
    await expect(svc.myAvailable('u1')).resolves.toEqual({ available: 0, canWithdraw: true });
  });

  it('a withdrawal equal to the reported available balance is accepted', async () => {
    const { svc, prisma } = makeWorld([{ id: 'v1', userId: 'u1', balance: 1234.56, baseHold: 200 }]);
    const { available } = await svc.myAvailable('u1');
    await expect(svc.request('u1', available)).resolves.toMatchObject({ amount: 1034.56 });
    expect(prisma.withdrawalRequest.create).toHaveBeenCalled();
  });

  it('a withdrawal above the reported available balance is rejected', async () => {
    const { svc, prisma } = makeWorld([{ id: 'v1', userId: 'u1', balance: 1234.56, baseHold: 200 }]);
    const { available } = await svc.myAvailable('u1');
    await expect(svc.request('u1', available + 0.01)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withdrawalRequest.create).not.toHaveBeenCalled();
  });
});
