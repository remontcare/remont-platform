import { RefundsService } from './refunds.module';

/**
 * Phase 6 —
 *  C-06: a refund that moves money for an order that already has an issued Invoice must
 *  produce a CreditNote against it — previously the Invoice was never touched/adjusted at
 *  all after a post-invoice refund.
 *  H-06: a refund decided after this order's warranty hold has already matured/released
 *  (vendor already paid out) previously had NO recovery path — the vendor kept the full
 *  payout and Remont absorbed the whole refund. Must now claw it back from the vendor's
 *  live balance instead.
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

function makeService() {
  let current: any = null;
  const prisma: any = {
    order: { findUnique: jest.fn(async () => ({ id: 'order-1', totalAmount: 1000, paymentStatus: 'PAID' })), update: jest.fn(async (args: any) => ({ id: 'o1', ...args.data })) },
    masterOrder: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: 'mo1', ...args.data })) },
    serviceVendor: { findUnique: jest.fn() },
    paymentTransaction: { findFirst: jest.fn(), findMany: jest.fn(async () => [{ amount: 1000 }]) },
    refundRequest: {
      findUniqueOrThrow: jest.fn(async () => (current ? { ...current } : null)),
      create: jest.fn(async (args: any) => { current = { id: 'rr-1', status: 'REQUESTED', ...args.data }; return current; }),
      findUnique: jest.fn(async () => (current ? { ...current } : null)),
      updateMany: jest.fn(async (args: any) => {
        if (!current || current.id !== args.where.id) return { count: 0 };
        const statusFilter = args.where.status;
        const matches = statusFilter?.in ? statusFilter.in.includes(current.status) : current.status === statusFilter;
        if (!matches) return { count: 0 };
        current = { ...current, ...args.data };
        return { count: 1 };
      }),
      update: jest.fn(async (args: any) => { current = { ...current, ...args.data }; return { id: args.where.id, ...current }; }),
      findMany: jest.fn(async () => []),
    },
    refundRequestLog: { create: jest.fn(async () => ({})) },
    walletTransaction: { findFirst: jest.fn(async () => null) }, // no earlier credit for this request
    user: { findUnique: jest.fn(async () => ({ phone: '9999999999' })) },
    partnerHold: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn(async () => []), // booking-level advisory lock
    refundWalletCredit: { create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) }, // once-only credit guard
    providerRefund: providerRefundStore(),
  };
  const payments: any = {
    refundPayment: jest.fn(async () => ({ refundId: 'rfnd_1', gateway: 'RAZORPAY' })),
    createRazorpayRefund: jest.fn(async (_p: string, amountPaise: number) => ({ ok: true, refund: { id: 'rfnd_1', status: 'processed', amount: amountPaise } })),
  };
  const wallet: any = { credit: jest.fn(async () => ({})) };
  const paymentNotify: any = { refundProcessed: jest.fn(async () => {}) };
  const ledger: any = { deductFromHold: jest.fn(async () => ({})), clawbackFromBalance: jest.fn(async () => ({})) };
  const invoices: any = { issueCreditNote: jest.fn(async () => ({ id: 'cn-1' })) };
  const svc = new RefundsService(prisma, payments, wallet, paymentNotify, ledger, invoices);
  const setCurrent = (row: any) => { current = row; };
  return { svc, prisma, payments, wallet, paymentNotify, ledger, invoices, setCurrent };
}

describe('RefundsService.decide — credit note issuance (C-06)', () => {
  it('issues a credit note after a WALLET_CREDIT refund actually moves money', async () => {
    const { svc, setCurrent, invoices } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 300, adminNotes: 'Defective item' });
    expect(invoices.issueCreditNote).toHaveBeenCalledWith('order-1', 'rr-1', 300, 'Defective item');
  });

  it('issues a credit note after a GATEWAY_REFUND too', async () => {
    const { svc, prisma, setCurrent, invoices } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'ptx-1', amount: 500, gateway: 'RAZORPAY', gatewayPaymentId: 'pay_1' });
    await svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 500 });
    expect(invoices.issueCreditNote).toHaveBeenCalledWith('order-1', 'rr-1', 500, expect.any(String));
  });

  it('does NOT issue a credit note for NO_REFUND — no money moved, nothing to correct', async () => {
    const { svc, setCurrent, invoices } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    await svc.decide('admin-1', 'rr-1', 'NO_REFUND', {});
    expect(invoices.issueCreditNote).not.toHaveBeenCalled();
  });

  it('a credit-note failure never blocks or undoes an already-completed refund', async () => {
    const { svc, setCurrent, invoices } = makeService();
    invoices.issueCreditNote.mockRejectedValue(new Error('DB unreachable'));
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    const result = await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 300 });
    expect(result.approvedAmount).toBe(300); // refund itself still completed successfully
  });
});

// FINAL decision: no refund route recovers from the partner automatically — not from a live
// warranty hold, not from the live balance. Recovery is a separate, explicit admin decision
// (RefundsService.recordPartnerRecovery), tested in refunds.providerRefund.spec.ts.
describe('RefundsService.decide — no automatic partner recovery on any refund path', () => {
  it('a live warranty hold is NOT deducted', async () => {
    const { svc, prisma, setCurrent, ledger } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.partnerHold.findFirst.mockResolvedValue({ id: 'hold-1' });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 });
    expect(ledger.deductFromHold).not.toHaveBeenCalled();
    expect(ledger.clawbackFromBalance).not.toHaveBeenCalled();
  });

  it('a completed, paid-out job without a hold is NOT clawed back from the live balance', async () => {
    const { svc, prisma, setCurrent, ledger } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', totalAmount: 1000, paymentStatus: 'PAID', vendorId: 'vendor-a', status: 'COMPLETED', completedAt: new Date() });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 });
    expect(ledger.clawbackFromBalance).not.toHaveBeenCalled();
  });
});
