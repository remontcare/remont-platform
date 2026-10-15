import { RefundsService } from './refunds.module';

/**
 * Approved rule (partner ledger safety): a customer refund is never automatically recovered from
 * the partner when a support case raised it (any recovery is a separate admin decision), and a
 * partner is never charged for a job they were never paid for. A wallet credit for one refund
 * request is posted at most once, even when decide() is retried after a partial failure.
 */
// In-memory ProviderRefund table (one gateway refund per refund request).
function providerRefundStore() {
  const rows = new Map<string, any>();
  const apply = (r: any, data: any) => {
    const n = { ...r };
    for (const [k, v] of Object.entries(data)) n[k] = v && typeof v === 'object' && 'increment' in (v as any) ? Number(r[k] || 0) + (v as any).increment : v;
    return n;
  };
  return {
    rows,
    findUnique: jest.fn(async ({ where }: any) => (where.id ? rows.get(where.id) ?? null : [...rows.values()].find((r) => r.refundRequestId === where.refundRequestId) ?? null)),
    findFirst: jest.fn(async ({ where }: any) => [...rows.values()].find((r) => (where.OR || []).some((c: any) => (c.providerRefundId && r.providerRefundId === c.providerRefundId) || (c.id?.in && c.id.in.includes(r.id)))) ?? null),
    create: jest.fn(async ({ data }: any) => { const r = { id: 'prf_' + (rows.size + 1), status: 'CREATED', attempts: 0, providerRefundId: null, ...data }; rows.set(r.id, r); return r; }),
    update: jest.fn(async ({ where, data }: any) => { const n = apply(rows.get(where.id), data); rows.set(where.id, n); return n; }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const r = rows.get(where.id);
      if (!r || (where.status?.in && !where.status.in.includes(r.status))) return { count: 0 };
      rows.set(where.id, apply(r, data));
      return { count: 1 };
    }),
  };
}

function makeService(o: { rr?: any; order?: any; hold?: any; existingCredit?: any } = {}) {
  let current: any = { id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1', ...o.rr };
  const prisma: any = {
    order: { findUnique: jest.fn(async () => ({ id: 'order-1', totalAmount: 1180, paymentStatus: 'PAID', vendorId: 'vendor-a', status: 'COMPLETED', completedAt: new Date(), ...o.order })), update: jest.fn() },
    refundRequest: {
      findUniqueOrThrow: jest.fn(async () => (current ? { ...current } : null)),
      findUnique: jest.fn(async () => ({ ...current })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async (a: any) => { current = { ...current, ...a.data }; return current; }),
      findMany: jest.fn(async () => []),
    },
    refundRequestLog: { create: jest.fn(async () => ({})) },
    walletTransaction: { findFirst: jest.fn(async () => o.existingCredit ?? null) },
    paymentTransaction: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => [{ amount: 1000 }]) },
    user: { findUnique: jest.fn(async () => ({ phone: '9' })) },
    partnerHold: { findFirst: jest.fn(async () => o.hold ?? null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn(async () => []), // booking-level advisory lock
    refundWalletCredit: { create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) }, // once-only credit guard
    providerRefund: providerRefundStore(),
  };
  const wallet: any = { credit: jest.fn(async () => ({ id: 'wt-1' })) };
  const ledger: any = { deductFromHold: jest.fn(async () => ({})), clawbackFromBalance: jest.fn(async () => ({})) };
  const svc = new RefundsService(prisma, {} as any, wallet, { refundProcessed: jest.fn(async () => {}) } as any, ledger, { issueCreditNote: jest.fn(async () => null) } as any);
  return { svc, prisma, wallet, ledger };
}

describe('Partner ledger safety on refunds', () => {
  it('a refund raised by a support case never touches the partner — not the hold, not the live balance', async () => {
    const t = makeService({ rr: { supportCaseId: 'case-1' }, hold: { id: 'hold-1' } });
    await t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 500 });
    expect(t.wallet.credit).toHaveBeenCalledTimes(1);
    expect(t.ledger.deductFromHold).not.toHaveBeenCalled();
    expect(t.ledger.clawbackFromBalance).not.toHaveBeenCalled();
  });

  it('a job that never completed was never paid out — no clawback from the partner\'s balance', async () => {
    const t = makeService({ order: { status: 'CANCELLED', completedAt: null } });
    await t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 500 });
    expect(t.ledger.clawbackFromBalance).not.toHaveBeenCalled();
  });

  // FINAL decision: Admin › Refunds no longer recovers automatically either — recovery is explicit.
  it('Admin › Refunds on a completed, paid-out job: no automatic recovery from the partner', async () => {
    const t = makeService();
    await t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 500 });
    expect(t.ledger.clawbackFromBalance).not.toHaveBeenCalled();
    expect(t.ledger.deductFromHold).not.toHaveBeenCalled();
  });
});

describe('Wallet credit at most once per refund request', () => {
  it('a retry after a partial failure finds the earlier credit and does not credit again', async () => {
    const t = makeService({ rr: { status: 'UNDER_REVIEW', supportCaseId: 'case-1' }, existingCredit: { id: 'wt-earlier' } });
    await t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 500 });
    expect(t.prisma.walletTransaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { refundRequestId: 'rr-1', type: 'CREDIT' } }));
    expect(t.wallet.credit).not.toHaveBeenCalled();
  });
});
