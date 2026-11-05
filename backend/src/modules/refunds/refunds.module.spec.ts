import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RefundsService } from './refunds.module';

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
  // Stateful updateMany models the real atomic claim: it only "succeeds" (count 1) when the
  // in-memory status is still one of ACTIVE_STATUSES at call time — the same guarantee a real
  // DB row-level conditional UPDATE gives two concurrent/retried callers.
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
    // No live Warranty Hold in these tests by default — the deductFromHold hook is a no-op.
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
  const invoices: any = { issueCreditNote: jest.fn(async () => null) };
  const svc = new RefundsService(prisma, payments, wallet, paymentNotify, ledger, invoices);
  const setCurrent = (row: any) => { current = row; };
  return { svc, prisma, payments, wallet, paymentNotify, ledger, invoices, setCurrent };
}

describe('RefundsService.raise', () => {
  it('rejects a customer raising a request for someone else\'s order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', paymentStatus: 'PAID', vendorId: 'v1' });
    await expect(svc.raise('random-user', 'o1', undefined, 'Damaged item', [])).rejects.toThrow(ForbiddenException);
  });

  it('rejects an order that was never paid', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', paymentStatus: 'PENDING', vendorId: 'v1' });
    await expect(svc.raise('cust-1', 'o1', undefined, 'Damaged item', [])).rejects.toThrow(BadRequestException);
  });

  it('creates the request as REQUESTED and logs it', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', paymentStatus: 'PAID', vendorId: 'vendor-a' });
    const rr = await svc.raise('cust-1', 'o1', undefined, 'Work not satisfactory', ['photo1.jpg']);
    expect(rr.status).toBe('REQUESTED');
    expect(prisma.refundRequestLog.create).toHaveBeenCalled();
  });
});

describe('RefundsService.partnerRespond', () => {
  it('rejects a vendor who is not the assigned partner', async () => {
    const { svc, prisma } = makeService();
    prisma.refundRequest.findUnique.mockResolvedValueOnce({ id: 'rr-1', partnerId: 'vendor-a', status: 'REQUESTED' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-b' });
    await expect(svc.partnerRespond('user-b', 'rr-1', 'Not my fault')).rejects.toThrow(ForbiddenException);
  });

  it('rejects responding to a request that is no longer awaiting one', async () => {
    const { svc, prisma } = makeService();
    prisma.refundRequest.findUnique.mockResolvedValueOnce({ id: 'rr-1', partnerId: 'vendor-a', status: 'PROCESSED' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-a' });
    await expect(svc.partnerRespond('vendor-user-a', 'rr-1', 'ok')).rejects.toThrow(BadRequestException);
  });
});

describe('RefundsService.decide — the only place money or a wallet credit actually moves', () => {
  it('rejects deciding a request that has already been decided', async () => {
    const { svc, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'PROCESSED' });
    await expect(svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {})).rejects.toThrow(BadRequestException);
  });

  it('NO_REFUND rejects the request without moving any money', async () => {
    const { svc, prisma, wallet, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    const result = await svc.decide('admin-1', 'rr-1', 'NO_REFUND' as any, {});
    expect(result.status).toBe('REJECTED');
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it('WALLET_CREDIT (the default per business rule) credits the customer\'s wallet for the full amount', async () => {
    const { svc, prisma, wallet, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    const result = await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {});
    expect(wallet.credit).toHaveBeenCalledWith('cust-1', 1000, 'REFUND', 'o1', expect.any(String), 'rr-1', 'admin-1', expect.anything());
    expect(result.status).toBe('PROCESSED');
  });

  it('GATEWAY_REFUND calls the real gateway refund API against the original payment', async () => {
    const { svc, prisma, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', amount: 1000, gateway: 'RAZORPAY', gatewayPaymentId: 'pay_1' });
    const result = await svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {});
    // one provider refund with a stable idempotency key derived from the request
    expect(payments.createRazorpayRefund).toHaveBeenCalledWith('pay_1', 100000, 'rfnd_rr-1', expect.any(String), expect.objectContaining({ refund_request_id: 'rr-1' }));
    expect(result.status).toBe('PROCESSED'); // Razorpay answered "processed"
  });

  it('GATEWAY_REFUND fails clearly when only a cash-collected payment exists — no gateway to refund through', async () => {
    const { svc, prisma, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue(null); // the findFirst query filters gateway IN (RAZORPAY, PHONEPE)
    await expect(svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {})).rejects.toThrow(BadRequestException);
    expect(payments.createRazorpayRefund).not.toHaveBeenCalled();
  });

  it('PARTIAL_WALLET_PARTIAL_GATEWAY does both legs', async () => {
    const { svc, prisma, wallet, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', amount: 1000, gateway: 'RAZORPAY', gatewayPaymentId: 'pay_1' });
    const result = await svc.decide('admin-1', 'rr-1', 'PARTIAL_WALLET_PARTIAL_GATEWAY' as any, { walletCreditAmount: 300, gatewayRefundAmount: 700 });
    expect(wallet.credit).toHaveBeenCalledWith('cust-1', 300, 'REFUND', 'o1', expect.any(String), 'rr-1', 'admin-1', expect.anything());
    expect(payments.createRazorpayRefund).toHaveBeenCalledWith('pay_1', 70000, 'rfnd_rr-1', expect.any(String), expect.any(Object));
    // 300 + 700 == totalAmount (1000) -> full refund reflected on the order
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { paymentStatus: 'REFUNDED' } }));
    expect(result.status).toBe('PROCESSED');
  });

  it('does not flip the order to REFUNDED when only a partial amount was actually returned', async () => {
    const { svc, prisma, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 300 });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  // C-13 — "two simultaneous refund decisions": only the first can claim the request (its
  // status moves off the active set); the second must be rejected before it ever touches the
  // wallet/gateway, never processed twice.
  it('two simultaneous decide() calls for the same request: only the first moves money', async () => {
    const { svc, prisma, wallet, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });

    const first = await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {});
    expect(first.status).toBe('PROCESSED');
    await expect(svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {})).rejects.toBeInstanceOf(BadRequestException);

    expect(wallet.credit).toHaveBeenCalledTimes(1);
  });

  // FINAL decision (Razorpay safety): an uncertain gateway outcome (timeout) is NEVER rolled back
  // to a re-decidable state — Razorpay may still process the original refund. The request needs
  // attention, its reservation is kept, and only reconciliation (same key + amount) settles it.
  it('a gateway timeout leaves the refund NEEDS_ATTENTION with its claim kept — it cannot be decided again', async () => {
    const { svc, prisma, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000, paymentStatus: 'PAID' });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', amount: 1000, gateway: 'RAZORPAY', gatewayPaymentId: 'pay_1' });
    payments.createRazorpayRefund.mockResolvedValueOnce({ ok: false, kind: 'UNCERTAIN', message: 'No response from Razorpay: timeout' });

    const res = await svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {});
    expect(res.status).toBe('NEEDS_ATTENTION');
    expect(Number(res.claimedAmount)).toBe(1000);
    await expect(svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(payments.createRazorpayRefund).toHaveBeenCalledTimes(1);
  });
});
