import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * approveWithdrawal() previously posted its own separate WITHDRAWAL ledger entry AFTER
 * calling settlements.record() (a second, non-atomic transaction) — now settlements.record()
 * posts that ledger entry itself, atomically with the PartnerSettlement row and the
 * pendingPayout decrement, so this must delegate the ledger bookkeeping entirely and never
 * post a second, duplicate entry.
 */
function makeService() {
  const prisma: any = {
    withdrawalRequest: {
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
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
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, settlements, ledger, events };
}

describe('AdminService.approveWithdrawal', () => {
  it('404s on a missing request', async () => {
    const { svc, prisma } = makeService();
    prisma.withdrawalRequest.findUnique.mockResolvedValue(null);
    await expect(svc.approveWithdrawal('wr-missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request that was already reviewed', async () => {
    const { svc, prisma } = makeService();
    prisma.withdrawalRequest.findUnique.mockResolvedValue({ id: 'wr-1', status: 'PAID', vendorId: 'v1', amount: 500 });
    await expect(svc.approveWithdrawal('wr-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('delegates the payout+ledger bookkeeping entirely to settlements.record — no separate ledger.postEntry call here', async () => {
    const { svc, prisma, settlements, ledger } = makeService();
    prisma.withdrawalRequest.findUnique
      .mockResolvedValueOnce({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 })
      .mockResolvedValueOnce({ id: 'wr-1', status: 'PAID', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1', 'paid via bank');

    // settlements.record() is the sole place the WITHDRAWAL ledger entry gets posted now —
    // tagged with this withdrawal request's own id so it's traceable both ways.
    expect(settlements.record).toHaveBeenCalledWith('v1', 500, 'BANK_TRANSFER', 'admin-1', undefined, 'paid via bank', 'wr-1');
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });

  it('marks the withdrawal request PAID with the settlement reference', async () => {
    const { svc, prisma } = makeService();
    prisma.withdrawalRequest.findUnique.mockResolvedValue({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1');

    expect(prisma.withdrawalRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wr-1' },
      data: expect.objectContaining({ status: 'PAID', settlementId: 'settlement-1' }),
    }));
  });

  it('notifies the vendor after a successful approval', async () => {
    const { svc, prisma, events } = makeService();
    prisma.withdrawalRequest.findUnique.mockResolvedValue({ id: 'wr-1', status: 'PENDING', vendorId: 'v1', amount: 500 });

    await svc.approveWithdrawal('wr-1', 'admin-1');

    expect(events.emit).toHaveBeenCalledWith('withdrawal.approved', { userId: 'vendor-user-1', amount: 500, withdrawalId: 'wr-1' });
  });
});
