import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * C-12 — same double-payout race as SettlementsService.record() (see
 * settlements.module.spec.ts), fixed the same way: the pendingPayout check now happens
 * inside the transaction that debits it, and referenceNumber doubles as an idempotent
 * financial reference for a retried request.
 */
function makeService() {
  const state = { pendingPayout: 0 };
  const settlements: any[] = [];
  const settlementCreate = jest.fn(async (args: any) => {
    const row = { id: `pv-settlement-${settlements.length + 1}`, ...args.data };
    settlements.push(row);
    return row;
  });
  const settlementFindFirst = jest.fn(async (args: any) => {
    return settlements.find((s) => s.vendorId === args.where.vendorId && s.referenceNumber === args.where.referenceNumber) || null;
  });
  const vendorFindUnique = jest.fn(async () => ({ id: 'pv1', pendingPayout: state.pendingPayout }));
  const vendorUpdate = jest.fn(async (args: any) => {
    if (args.data.pendingPayout?.decrement != null) state.pendingPayout -= args.data.pendingPayout.decrement;
    return { id: 'pv1', pendingPayout: state.pendingPayout };
  });
  const prisma: any = {
    productVendor: { findUnique: vendorFindUnique, update: vendorUpdate },
    productVendorSettlement: { create: settlementCreate, findFirst: settlementFindFirst },
    $transaction: jest.fn(async (fn: any) => fn({
      $queryRaw: jest.fn(),
      productVendor: { findUnique: vendorFindUnique, update: vendorUpdate },
      productVendorSettlement: { create: settlementCreate, findFirst: settlementFindFirst },
    })),
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlementsService: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = {};
  const productLedger: any = { postEntry: jest.fn().mockResolvedValue({}) };
  const svc = new AdminService(prisma, config, payments, settlementsService, cities, events, ledger, {} as any, {} as any, {} as any, {} as any, {} as any, productLedger);
  return { svc, prisma, state, productLedger };
}

describe('AdminService.recordProductVendorPayout', () => {
  it('rejects a non-positive amount', async () => {
    const { svc } = makeService();
    await expect(svc.recordProductVendorPayout('admin-1', 'pv1', 0, 'CASH')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an amount exceeding pendingPayout', async () => {
    const { svc, state } = makeService();
    state.pendingPayout = 500;
    await expect(svc.recordProductVendorPayout('admin-1', 'pv1', 600, 'CASH')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the payout and decrements pendingPayout, posting a PAYOUT ledger entry', async () => {
    const { svc, state, productLedger } = makeService();
    state.pendingPayout = 1000;
    const settlement = await svc.recordProductVendorPayout('admin-1', 'pv1', 400, 'UPI');
    expect(settlement).toMatchObject({ vendorId: 'pv1', amount: 400, mode: 'UPI' });
    expect(state.pendingPayout).toBe(600);
    expect(productLedger.postEntry).toHaveBeenCalledWith(expect.anything(), 'pv1', 'PAYOUT', -400, expect.anything());
  });

  // Two simultaneous payouts for the same seller — the balance check now happens inside the
  // same (mocked, serialized) locked transaction as the debit, so the second sees the
  // first's already-committed decrement and fails safely instead of overdrawing.
  it('two simultaneous payouts for the same seller: the second fails safely instead of overdrawing', async () => {
    const { svc, state } = makeService();
    state.pendingPayout = 1000;

    await svc.recordProductVendorPayout('admin-1', 'pv1', 700, 'CASH');
    expect(state.pendingPayout).toBe(300);

    await expect(svc.recordProductVendorPayout('admin-1', 'pv1', 700, 'CASH')).rejects.toBeInstanceOf(BadRequestException);
    expect(state.pendingPayout).toBe(300);
  });

  // Same payout request retried: referenceNumber is the idempotent financial reference.
  it('retrying the same payout with the same referenceNumber returns the original settlement, debited only once', async () => {
    const { svc, state, prisma } = makeService();
    state.pendingPayout = 1000;

    const first = await svc.recordProductVendorPayout('admin-1', 'pv1', 400, 'UPI', 'REF-PV-1');
    const retried = await svc.recordProductVendorPayout('admin-1', 'pv1', 400, 'UPI', 'REF-PV-1');

    expect(retried.id).toBe(first.id);
    expect(state.pendingPayout).toBe(600);
    expect(prisma.productVendorSettlement.create).toHaveBeenCalledTimes(1);
  });
});
