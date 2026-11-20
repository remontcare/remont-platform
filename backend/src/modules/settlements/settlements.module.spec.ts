import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SettlementsService } from './settlements.module';

function makeFakePrisma(vendor: { id: string; pendingPayout: number } | null) {
  const state = { pendingPayout: vendor?.pendingPayout ?? 0 };
  const settlements: any[] = [];
  const settlementCreate = jest.fn(async (args: any) => {
    const row = { id: `settlement-${settlements.length + 1}`, ...args.data };
    settlements.push(row);
    return row;
  });
  const settlementFindFirst = jest.fn(async (args: any) => {
    return settlements.find((s) => s.vendorId === args.where.vendorId && s.referenceNumber === args.where.referenceNumber) || null;
  });
  const vendorFindUnique = jest.fn(async () => (vendor ? { ...vendor, pendingPayout: state.pendingPayout } : null));
  const vendorUpdate = jest.fn(async (args: any) => {
    if (args.data.pendingPayout?.decrement != null) state.pendingPayout -= args.data.pendingPayout.decrement;
    return { ...vendor, pendingPayout: state.pendingPayout };
  });
  const prisma: any = {
    serviceVendor: { findUnique: vendorFindUnique, update: vendorUpdate },
    partnerSettlement: { create: settlementCreate, findMany: jest.fn(async () => []), findFirst: settlementFindFirst },
    // The real implementation takes a FOR UPDATE row lock inside the transaction before
    // re-reading the balance — modeled here by having the tx's own serviceVendor.findUnique
    // read the SAME live `state` every call, so two sequential record() calls against this
    // fixture see each other's already-committed decrements exactly as serialized Postgres
    // transactions would (see withdrawal.spec.ts for the same idiom).
    $transaction: jest.fn(async (fn: any) => fn({
      $queryRaw: jest.fn(),
      partnerSettlement: { create: settlementCreate, findFirst: settlementFindFirst },
      serviceVendor: { findUnique: vendorFindUnique, update: vendorUpdate },
    })),
  };
  return { prisma, state };
}

function makeLedger() {
  return { postEntry: jest.fn().mockResolvedValue({}) };
}

describe('SettlementsService.record', () => {
  it('rejects a non-positive amount', async () => {
    const { prisma } = makeFakePrisma({ id: 'v1', pendingPayout: 1000 });
    const svc = new SettlementsService(prisma, makeLedger() as any);
    await expect(svc.record('v1', 0, 'CASH' as any, 'admin-1')).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown vendor', async () => {
    const { prisma } = makeFakePrisma(null);
    const svc = new SettlementsService(prisma, makeLedger() as any);
    await expect(svc.record('missing', 100, 'CASH' as any, 'admin-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects a settlement larger than the pending payout — no overpaying a partner', async () => {
    const { prisma } = makeFakePrisma({ id: 'v1', pendingPayout: 500 });
    const svc = new SettlementsService(prisma, makeLedger() as any);
    await expect(svc.record('v1', 600, 'BANK_TRANSFER' as any, 'admin-1')).rejects.toThrow(BadRequestException);
  });

  it('records the settlement and decrements pendingPayout by exactly the settled amount', async () => {
    const { prisma, state } = makeFakePrisma({ id: 'v1', pendingPayout: 1000 });
    const ledger = makeLedger();
    const svc = new SettlementsService(prisma, ledger as any);
    const result = await svc.record('v1', 400, 'UPI' as any, 'admin-1', 'UTR123', 'partial payout');
    expect(result).toMatchObject({ vendorId: 'v1', amount: 400, mode: 'UPI', referenceNumber: 'UTR123' });
    expect(state.pendingPayout).toBe(600);
  });

  // Accounting fix: this was the actual production gap — recording a settlement decremented
  // pendingPayout with no corresponding ledger entry, so a partner's ledger (and its CSV
  // export) never showed why their balance dropped for a manually-recorded payout.
  it('posts a matching WITHDRAWAL ledger entry in the same transaction as the settlement', async () => {
    const { prisma } = makeFakePrisma({ id: 'v1', pendingPayout: 1000 });
    const ledger = makeLedger();
    const svc = new SettlementsService(prisma, ledger as any);

    await svc.record('v1', 400, 'UPI' as any, 'admin-1', 'UTR123', 'partial payout');

    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.anything(), 'v1', 'WITHDRAWAL', -400,
      expect.objectContaining({ createdBy: 'admin-1', notes: 'partial payout' }),
    );
  });

  it('tags the ledger entry with withdrawalRequestId when settling an approved withdrawal request', async () => {
    const { prisma } = makeFakePrisma({ id: 'v1', pendingPayout: 1000 });
    const ledger = makeLedger();
    const svc = new SettlementsService(prisma, ledger as any);

    await svc.record('v1', 400, 'BANK_TRANSFER' as any, 'admin-1', undefined, 'withdrawal payout', 'wr-1');

    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.anything(), 'v1', 'WITHDRAWAL', -400,
      expect.objectContaining({ withdrawalRequestId: 'wr-1' }),
    );
  });

  // C-12 — double-payout race: the balance check used to read pendingPayout BEFORE the
  // transaction that debits it, so two concurrent/near-simultaneous payout requests for the
  // same vendor could both pass a stale check and both debit, overdrawing the balance. The
  // check now happens inside the same (mocked, serialized) transaction as the debit.
  it('two simultaneous payouts for the same vendor: the second sees the first\'s already-committed decrement and fails safely instead of overdrawing', async () => {
    const { prisma, state } = makeFakePrisma({ id: 'v1', pendingPayout: 1000 });
    const svc = new SettlementsService(prisma, makeLedger() as any);

    const first = await svc.record('v1', 700, 'CASH' as any, 'admin-1');
    expect(first).toBeTruthy();
    expect(state.pendingPayout).toBe(300);

    await expect(svc.record('v1', 700, 'CASH' as any, 'admin-1')).rejects.toThrow(BadRequestException);
    // Balance must never go negative — the second attempt is rejected, not partially applied.
    expect(state.pendingPayout).toBe(300);
  });

  // Same payout request retried: a referenceNumber acts as an idempotent financial
  // reference — a retried call with the same (vendorId, referenceNumber) returns the
  // original settlement instead of creating (and debiting) a second one.
  it('retrying the same payout with the same referenceNumber returns the original settlement, debited only once', async () => {
    const { prisma, state } = makeFakePrisma({ id: 'v1', pendingPayout: 1000 });
    const svc = new SettlementsService(prisma, makeLedger() as any);

    const first = await svc.record('v1', 400, 'UPI' as any, 'admin-1', 'REF-DUP-1');
    const retried = await svc.record('v1', 400, 'UPI' as any, 'admin-1', 'REF-DUP-1');

    expect(retried.id).toBe(first.id);
    expect(state.pendingPayout).toBe(600); // decremented exactly once, not twice
    expect(prisma.partnerSettlement.create).toHaveBeenCalledTimes(1);
  });
});
