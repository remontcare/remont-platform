import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * approveWithdrawal() previously posted its own separate WITHDRAWAL ledger entry AFTER
 * calling settlements.record() (a second, non-atomic transaction) — now settlements.record()
 * posts that ledger entry itself, atomically with the PartnerSettlement row and the
 * pendingPayout decrement, so this must delegate the ledger bookkeeping entirely and never
 * post a second, duplicate entry.
 *
 * C-12/C-13 hardening — the status check + write is now an atomic updateMany claim (PENDING
 * -> PAID) BEFORE settlements.record() runs, so two concurrent/retried approvals of the same
 * request can never both pay the vendor. `updateMany` models a real DB's row-level guarantee:
 * it only "succeeds" (count 1) when the current in-memory status still matches PENDING.
 */
function makeService() {
  let current: any = null; // the WithdrawalRequest row this fixture is modeling
  const prisma: any = {
    withdrawalRequest: {
      findUnique: jest.fn(async () => (current ? { ...current } : null)),
      updateMany: jest.fn(async (args: any) => {
        if (!current || current.id !== args.where.id || current.status !== args.where.status) return { count: 0 };
        current = { ...current, ...args.data };
        return { count: 1 };
      }),
      update: jest.fn(async (args: any) => {
        current = { ...current, ...args.data };
        return { id: args.where.id, ...current };
      }),
    },
    serviceVendor: { findUnique: jest.fn().mockResolvedValue({ userId: 'vendor-user-1' }) },
    auditLog: { create: jest.fn() },
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = { record: jest.fn(async (vendorId: string, amount: number, mode: any, adminId: string, ref?: string, notes?: string, withdrawalRequestId?: string) => ({ id: 'settlement-1', vendorId, amount, mode, withdrawalRequestId })) };
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = { postEntry: jest.fn() };
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const setCurrent = (row: any) => { current = row; };
  return { svc, prisma, settlements, ledger, events, setCurrent };
}

describe('AdminService.approveWithdrawal', () => {
  it('404s on a missing request', async () => {
    const { svc } = makeService();
    await expect(svc.approveWithdrawal('wr-missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request that was already reviewed', async () => {
    const { svc, setCurrent } = makeService();
    setCurrent({ id: 'wr-1', status: 'PAID', vendorId: 'v1', amount: 500 });
    await expect(svc.approveWithdrawal('wr-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('delegates the payout+ledger bookkeeping entirely to settlements.record — no separate ledger.postEntry call here', async () => {
    const { svc, settlements, ledger, setCurrent } = makeService();
    setCurrent({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1', 'paid via bank');

    // settlements.record() is the sole place the WITHDRAWAL ledger entry gets posted now —
    // tagged with this withdrawal request's own id so it's traceable both ways.
    expect(settlements.record).toHaveBeenCalledWith('v1', 500, 'BANK_TRANSFER', 'admin-1', undefined, 'paid via bank', 'wr-1');
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('marks the withdrawal request PAID with the settlement reference', async () => {
    const { svc, prisma, setCurrent } = makeService();
    setCurrent({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1');

    expect(prisma.withdrawalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'wr-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'PAID' }),
    });
    expect(prisma.withdrawalRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wr-1' },
      data: expect.objectContaining({ settlementId: 'settlement-1' }),
    }));
  });

  it('notifies the vendor after a successful approval', async () => {
    const { svc, events, setCurrent } = makeService();
    setCurrent({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1');

    expect(events.emit).toHaveBeenCalledWith('withdrawal.approved', { userId: 'vendor-user-1', amount: 500, withdrawalId: 'wr-1' });
  });

  // C-12/C-13 — "same payout request retried": two concurrent/rapid approve calls for the
  // SAME withdrawal request must never both pay the vendor. Only the first's updateMany
  // claim can match (status still PENDING); the second finds status already PAID and is
  // rejected before settlements.record() is ever called a second time.
  it('two concurrent approvals of the same withdrawal request: only one pays out', async () => {
    const { svc, settlements, setCurrent } = makeService();
    setCurrent({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1');
    await expect(svc.approveWithdrawal('wr-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);

    expect(settlements.record).toHaveBeenCalledTimes(1);
  });

  // Retry-after-failure safety: if settlements.record() throws (e.g. a stale/insufficient
  // balance edge case), the claim must roll back to PENDING so the request is retryable
  // instead of being stuck "PAID" with no money actually recorded.
  it('rolls back the claim to PENDING when settlements.record() fails, so the request can be retried', async () => {
    const { svc, settlements, prisma, setCurrent } = makeService();
    setCurrent({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });
    settlements.record.mockRejectedValueOnce(new BadRequestException('Amount exceeds pending payout'));

    await expect(svc.approveWithdrawal('wr-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    const row = await prisma.withdrawalRequest.findUnique({ where: { id: 'wr-1' } });
    expect(row.status).toBe('PENDING');
  });
});
