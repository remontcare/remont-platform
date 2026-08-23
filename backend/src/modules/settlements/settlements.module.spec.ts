import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SettlementsService } from './settlements.module';

function makeFakePrisma(vendor: { id: string; pendingPayout: number } | null) {
  const state = { pendingPayout: vendor?.pendingPayout ?? 0 };
  const settlementCreate = jest.fn(async (args: any) => ({ id: 'settlement-1', ...args.data }));
  const vendorUpdate = jest.fn(async (args: any) => {
    if (args.data.pendingPayout?.decrement != null) state.pendingPayout -= args.data.pendingPayout.decrement;
    return { ...vendor, pendingPayout: state.pendingPayout };
  });
  const prisma: any = {
    serviceVendor: {
      findUnique: jest.fn(async () => (vendor ? { ...vendor, pendingPayout: state.pendingPayout } : null)),
      update: vendorUpdate,
    },
    partnerSettlement: {
      create: settlementCreate,
      findMany: jest.fn(async () => []),
    },
    $transaction: jest.fn(async (fn: any) => fn({
      partnerSettlement: { create: settlementCreate },
      serviceVendor: { update: vendorUpdate },
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
});
