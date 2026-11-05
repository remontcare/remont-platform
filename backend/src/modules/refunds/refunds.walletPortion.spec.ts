import { BadRequestException } from '@nestjs/common';
import { RefundsService } from './refunds.module';

/**
 * Audit M3 — the wallet portion of an UNPAID (cash-on-service) booking is refundable through the
 * existing pipeline, but only when a support-case cancellation asks for it; customers raising a
 * refund themselves keep the existing "no payment to refund" rule, and an unpaid order is never
 * marked REFUNDED.
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

function makeService(order: any) {
  let current: any = null;
  const prisma: any = {
    order: { findUnique: jest.fn(async () => order), update: jest.fn(async (a: any) => a.data) },
    refundRequest: {
      findUniqueOrThrow: jest.fn(async () => (current ? { ...current } : null)),
      create: jest.fn(async (a: any) => { current = { id: 'rr-1', status: 'REQUESTED', ...a.data }; return current; }),
      findUnique: jest.fn(async () => current),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async (a: any) => ({ ...current, ...a.data })),
      findMany: jest.fn(async () => []),
    },
    refundRequestLog: { create: jest.fn(async () => ({})) },
    walletTransaction: { findFirst: jest.fn(async () => null) }, // no earlier credit for this request
    paymentTransaction: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => [{ amount: 1000 }]) },
    user: { findUnique: jest.fn(async () => ({ phone: '9' })) },
    partnerHold: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn(async () => []), // booking-level advisory lock
    refundWalletCredit: { create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) }, // once-only credit guard
    providerRefund: providerRefundStore(),
  };
  const wallet: any = { credit: jest.fn(async () => ({})) };
  const svc = new RefundsService(prisma, {} as any, wallet, { refundProcessed: jest.fn(async () => {}) } as any,
    { clawbackFromBalance: jest.fn(async () => ({})), deductFromHold: jest.fn() } as any, { issueCreditNote: jest.fn(async () => null) } as any);
  return { svc, prisma, wallet };
}
const UNPAID_WITH_WALLET = { id: 'o1', customerId: 'cust-1', paymentStatus: 'PENDING', totalAmount: 80, walletUsed: 120, vendorId: null };

describe('M3 — wallet portion of an unpaid booking', () => {
  it('a customer-raised refund on an unpaid order is still refused (unchanged rule)', async () => {
    const { svc } = makeService(UNPAID_WITH_WALLET);
    await expect(svc.raise('cust-1', 'o1', undefined, 'x', [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a support-case cancellation may raise it (allowWalletPortion) …', async () => {
    const { svc } = makeService(UNPAID_WITH_WALLET);
    await expect(svc.raise('cust-1', 'o1', undefined, 'x', [], { allowWalletPortion: true })).resolves.toEqual(expect.objectContaining({ id: 'rr-1' }));
  });

  it('… but not when no wallet money was used', async () => {
    const { svc } = makeService({ ...UNPAID_WITH_WALLET, walletUsed: 0 });
    await expect(svc.raise('cust-1', 'o1', undefined, 'x', [], { allowWalletPortion: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('crediting the wallet portion never marks the unpaid order REFUNDED', async () => {
    const { svc, prisma, wallet } = makeService(UNPAID_WITH_WALLET);
    await svc.raise('cust-1', 'o1', undefined, 'x', [], { allowWalletPortion: true });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 120 }); // 120 ≥ totalAmount 80
    expect(wallet.credit).toHaveBeenCalledWith('cust-1', 120, 'REFUND', 'o1', expect.any(String), 'rr-1', 'admin-1', expect.anything());
    expect(prisma.order.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { paymentStatus: 'REFUNDED' } }));
  });
});
