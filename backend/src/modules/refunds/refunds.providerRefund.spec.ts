import { BadRequestException } from '@nestjs/common';
import { RefundsService, RefundCapacityExceeded } from './refunds.module';

/**
 * Final financial-safety rules for refunds:
 *  - one provider refund per request: stable internal id + idempotency key, reused on EVERY retry
 *    with the identical amount — a timeout never mints a new key;
 *  - pending / processed / failed / unknown are distinct; accepted ≠ completed;
 *  - webhooks (already signature-checked + de-duplicated by PaymentsService) are monotonic:
 *    duplicates and out-of-order deliveries never re-finalise or roll a final state back;
 *  - reconciliation settles uncertainty without ever risking a second refund;
 *  - the booking-wide limit is enforced inside the claim, before any money moves;
 *  - partner recovery is explicit, capped by what the partner earned, and posted at most once.
 */
function makeService(opts: { otherClaims?: any[]; received?: number; order?: any } = {}) {
  const requests = new Map<string, any>();
  const providerRefunds = new Map<string, any>();
  const cases = new Map<string, any>([['case-1', { id: 'case-1', refundedTotal: 1000, partnerRecovery: null, partnerRecoveredAt: null }]]);
  const apply = (r: any, data: any) => {
    const n = { ...r };
    for (const [k, v] of Object.entries(data)) n[k] = v && typeof v === 'object' && 'increment' in (v as any) ? Number(r[k] || 0) + (v as any).increment : v;
    return n;
  };
  const statusOk = (r: any, where: any) => !where.status || (where.status.in ? where.status.in.includes(r.status) : r.status === where.status);
  const order = { id: 'order-1', totalAmount: 1000, paymentStatus: 'PAID', walletUsed: 0, masterOrderId: null, vendorId: 'vendor-a', status: 'COMPLETED', completedAt: new Date(), vendorPayout: 800, orderNumber: 'REM-1', ...opts.order };
  const ledgerEntries: any[] = [];
  const prisma: any = {
    order: { findUnique: jest.fn(async () => order), update: jest.fn(async (a: any) => a.data) },
    masterOrder: { findUnique: jest.fn(async () => null) },
    paymentTransaction: {
      findFirst: jest.fn(async () => ({ id: 'ptx-1', amount: 1000, gateway: 'RAZORPAY', gatewayPaymentId: 'pay_1' })),
      findMany: jest.fn(async () => [{ amount: opts.received ?? 1000 }]),
    },
    refundRequest: {
      findUnique: jest.fn(async ({ where }: any) => (requests.get(where.id) ? { ...requests.get(where.id), providerRefund: [...providerRefunds.values()].find((p) => p.refundRequestId === where.id) ?? null } : null)),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({ ...requests.get(where.id), providerRefund: [...providerRefunds.values()].find((p) => p.refundRequestId === where.id) ?? null })),
      findMany: jest.fn(async ({ where }: any) => [
        ...[...requests.values()].filter((r) => (where?.OR || []).some((c: any) => c.orderId === r.orderId)),
        ...(opts.otherClaims || []),
      ]),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = requests.get(where.id);
        if (!r || !statusOk(r, where)) return { count: 0 };
        requests.set(where.id, apply(r, data));
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => { const n = apply(requests.get(where.id), data); requests.set(where.id, n); return n; }),
    },
    providerRefund: {
      findUnique: jest.fn(async ({ where }: any) => (where.id ? providerRefunds.get(where.id) ?? null : [...providerRefunds.values()].find((p) => p.refundRequestId === where.refundRequestId) ?? null)),
      findFirst: jest.fn(async ({ where }: any) => [...providerRefunds.values()].find((r) => (where.OR || []).some((c: any) => (c.providerRefundId && r.providerRefundId === c.providerRefundId) || (c.id?.in && c.id.in.includes(r.id)))) ?? null),
      create: jest.fn(async ({ data }: any) => { const r = { id: 'prf_1', status: 'CREATED', attempts: 0, providerRefundId: null, ...data }; providerRefunds.set(r.id, r); return r; }),
      update: jest.fn(async ({ where, data }: any) => { const n = apply(providerRefunds.get(where.id), data); providerRefunds.set(where.id, n); return n; }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = providerRefunds.get(where.id);
        if (!r || !statusOk(r, where)) return { count: 0 };
        providerRefunds.set(where.id, apply(r, data));
        return { count: 1 };
      }),
    },
    supportCase: {
      findUnique: jest.fn(async ({ where }: any) => cases.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => { const n = apply(cases.get(where.id), data); cases.set(where.id, n); return n; }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const k = cases.get(where.id);
        if (!k || (where.partnerRecoveredAt === null && k.partnerRecoveredAt)) return { count: 0 };
        cases.set(where.id, apply(k, data));
        return { count: 1 };
      }),
      findMany: jest.fn(async () => [...cases.values()].filter((k) => k.partnerRecoveredAt)),
    },
    serviceVendor: { update: jest.fn(async () => ({})) },
    walletTransaction: { findFirst: jest.fn(async () => null) },
    refundRequestLog: { create: jest.fn(async () => ({})) },
    auditLog: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn(async () => ({ phone: '9' })) },
    $queryRaw: jest.fn(async () => []),
    refundWalletCredit: { create: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const payments: any = {
    createRazorpayRefund: jest.fn(async (_p: string, amountPaise: number) => ({ ok: true, refund: { id: 'rfnd_1', status: 'pending', amount: amountPaise } })),
    fetchRazorpayRefund: jest.fn(),
    findRazorpayRefundByReceipt: jest.fn(async () => null),
  };
  const wallet: any = { credit: jest.fn(async () => ({ id: 'wt-1' })) };
  const ledger: any = { postEntry: jest.fn(async (_tx: any, vendorId: string, type: string, amount: number, meta: any) => { const e = { id: 'le-' + (ledgerEntries.length + 1), vendorId, type, amount, ...meta }; ledgerEntries.push(e); return e; }) };
  const invoices: any = { issueCreditNote: jest.fn(async () => ({ id: 'cn-1' })) };
  const notify: any = { refundProcessed: jest.fn(async () => {}) };
  const svc = new RefundsService(prisma, payments, wallet, notify, ledger, invoices);
  const addRequest = (r: any = {}) => { const row = { id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', masterOrderId: null, customerId: 'cust-1', claimedAmount: 0, partnerRecovery: null, partnerRecoveredAt: null, ...r }; requests.set(row.id, row); return row; };
  return { svc, prisma, payments, wallet, ledger, invoices, notify, requests, providerRefunds, cases, ledgerEntries, addRequest };
}
const pr = (t: any) => [...t.providerRefunds.values()][0];

describe('Razorpay refund — stable key, distinct states, accepted ≠ completed', () => {
  it('a pending refund is REFUND_PENDING: claim kept, no credit note, customer not told it is done', async () => {
    const t = makeService(); t.addRequest();
    const res: any = await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    expect(res.status).toBe('REFUND_PENDING');
    expect(Number(res.claimedAmount)).toBe(600);
    expect(pr(t)).toEqual(expect.objectContaining({ status: 'PENDING', providerRefundId: 'rfnd_1', idempotencyKey: 'rfnd_rr-1', amountPaise: 60000 }));
    expect(t.invoices.issueCreditNote).not.toHaveBeenCalled();
    expect(t.notify.refundProcessed).not.toHaveBeenCalled();
  });

  it('webhook "processed" completes it exactly once — a duplicate delivery changes nothing', async () => {
    const t = makeService(); t.addRequest();
    await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    const evt = { gateway: 'RAZORPAY', event: 'refund.processed', refundId: 'rfnd_1', status: 'processed', amount: 60000, receipt: 'prf_1' };
    await t.svc.onProviderRefundUpdate(evt);
    await t.svc.onProviderRefundUpdate(evt);
    expect(t.requests.get('rr-1').status).toBe('PROCESSED');
    expect(t.requests.get('rr-1').gatewayRefundId).toBe('rfnd_1');
    expect(t.invoices.issueCreditNote).toHaveBeenCalledTimes(1);
    expect(t.notify.refundProcessed).toHaveBeenCalledTimes(1);
  });

  it('out-of-order: a late "created/pending" or a contradicting "failed" never rolls PROCESSED back', async () => {
    const t = makeService(); t.addRequest();
    await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    await t.svc.onProviderRefundUpdate({ gateway: 'RAZORPAY', event: 'refund.processed', refundId: 'rfnd_1', amount: 60000 });
    await t.svc.onProviderRefundUpdate({ gateway: 'RAZORPAY', event: 'refund.created', refundId: 'rfnd_1', status: 'pending', amount: 60000 });
    await t.svc.onProviderRefundUpdate({ gateway: 'RAZORPAY', event: 'refund.failed', refundId: 'rfnd_1', amount: 60000 });
    expect(pr(t).status).toBe('PROCESSED');
    expect(t.requests.get('rr-1').status).toBe('PROCESSED');
    expect(Number(t.requests.get('rr-1').claimedAmount)).toBe(600);
  });

  it('a confirmed failure releases ONLY the gateway part of the reservation (and a support case\'s claim)', async () => {
    const t = makeService(); t.addRequest({ supportCaseId: 'case-1' });
    await t.svc.decide('admin-1', 'rr-1', 'PARTIAL_WALLET_PARTIAL_GATEWAY', { walletCreditAmount: 400, gatewayRefundAmount: 600 });
    await t.svc.onProviderRefundUpdate({ gateway: 'RAZORPAY', event: 'refund.failed', refundId: 'rfnd_1', amount: 60000 });
    expect(t.requests.get('rr-1').status).toBe('REFUND_FAILED');
    expect(Number(t.requests.get('rr-1').claimedAmount)).toBe(400); // the wallet credit really happened
    expect(Number(t.cases.get('case-1').refundedTotal)).toBe(400);
  });

  it('a definite rejection (e.g. amount > captured) fails cleanly and releases the claim', async () => {
    const t = makeService(); t.addRequest();
    t.payments.createRazorpayRefund.mockResolvedValueOnce({ ok: false, kind: 'DEFINITE_REJECTION', httpStatus: 400, message: 'The refund amount provided is greater than amount captured.' });
    const res: any = await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    expect(res.status).toBe('REFUND_FAILED');
    expect(Number(res.claimedAmount)).toBe(0);
  });

  it('a webhook whose amount differs from what we sent needs attention (never assumed)', async () => {
    const t = makeService(); t.addRequest();
    await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    t.prisma.providerRefund.updateMany.mockClear();
    await t.svc.onProviderRefundUpdate({ gateway: 'RAZORPAY', event: 'refund.processed', refundId: 'rfnd_1', amount: 99999 });
    expect(pr(t).status).toBe('PENDING'); // UNKNOWN never overwrites a known PENDING
    expect(pr(t).lastError).toMatch(/Webhook amount 99999/);
  });
});

describe('Timeout / uncertain status → reconciliation without a second refund', () => {
  async function timedOut() {
    const t = makeService(); t.addRequest();
    t.payments.createRazorpayRefund.mockResolvedValueOnce({ ok: false, kind: 'UNCERTAIN', message: 'No response from Razorpay: timeout' });
    const res: any = await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    expect(res.status).toBe('NEEDS_ATTENTION');
    expect(pr(t).status).toBe('UNKNOWN');
    return t;
  }

  it('the refund Razorpay DID create is found by our receipt and adopted — no new request sent', async () => {
    const t = await timedOut();
    t.payments.findRazorpayRefundByReceipt.mockResolvedValueOnce({ id: 'rfnd_9', status: 'processed', amount: 60000 });
    await t.svc.reconcileProviderRefund('admin-1', 'rr-1');
    expect(t.payments.findRazorpayRefundByReceipt).toHaveBeenCalledWith('pay_1', 'prf_1');
    expect(t.payments.createRazorpayRefund).toHaveBeenCalledTimes(1);
    expect(t.requests.get('rr-1').status).toBe('PROCESSED');
    expect(t.requests.get('rr-1').gatewayRefundId).toBe('rfnd_9');
  });

  it('nothing found → re-sent with the SAME idempotency key and the SAME amount (never a new key)', async () => {
    const t = await timedOut();
    await t.svc.reconcileProviderRefund('admin-1', 'rr-1');
    const calls = t.payments.createRazorpayRefund.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1][2]).toBe('rfnd_rr-1');
    expect(t.requests.get('rr-1').status).toBe('REFUND_PENDING');
  });

  it('"another request with the same key is still in progress" keeps it NEEDS_ATTENTION', async () => {
    const t = await timedOut();
    t.payments.createRazorpayRefund.mockResolvedValueOnce({ ok: false, kind: 'IN_PROGRESS', httpStatus: 409, message: 'Another request with the same idempotency key is still in progress.' });
    await t.svc.reconcileProviderRefund('admin-1', 'rr-1');
    expect(t.requests.get('rr-1').status).toBe('NEEDS_ATTENTION');
    expect(Number(t.requests.get('rr-1').claimedAmount)).toBe(600);
  });

  it('with a stored provider id, reconciliation fetches that refund\'s status', async () => {
    const t = makeService(); t.addRequest();
    await t.svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 600 });
    t.payments.fetchRazorpayRefund.mockResolvedValueOnce({ id: 'rfnd_1', status: 'processed', amount: 60000 });
    await t.svc.reconcileProviderRefund('admin-1', 'rr-1');
    expect(t.payments.fetchRazorpayRefund).toHaveBeenCalledWith('pay_1', 'rfnd_1');
    expect(t.requests.get('rr-1').status).toBe('PROCESSED');
  });

  it('Razorpay unreachable during reconciliation: nothing changes', async () => {
    const t = await timedOut();
    t.payments.findRazorpayRefundByReceipt.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(t.svc.reconcileProviderRefund('admin-1', 'rr-1')).rejects.toThrow(/nothing changed/);
    expect(t.requests.get('rr-1').status).toBe('NEEDS_ATTENTION');
    expect(t.payments.createRazorpayRefund).toHaveBeenCalledTimes(1);
  });
});

describe('Booking-wide limit inside the claim (every route)', () => {
  it('claims already held on the booking by other requests cap this one — refused before any money moves', async () => {
    const t = makeService({ otherClaims: [{ id: 'rr-other', status: 'REFUND_PENDING', claimedAmount: 800 }] });
    t.addRequest();
    await expect(t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 300 })).rejects.toBeInstanceOf(RefundCapacityExceeded);
    expect(t.requests.get('rr-1').status).toBe('REQUESTED');
    expect(t.wallet.credit).not.toHaveBeenCalled();
    await t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 });
    expect(t.wallet.credit).toHaveBeenCalledTimes(1);
  });

  it('a pre-existing processed refund without a reservation (decided before this release) still counts', async () => {
    const t = makeService({ otherClaims: [{ id: 'old', status: 'PROCESSED', claimedAmount: 0, approvedAmount: 900 }] });
    t.addRequest();
    await expect(t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 })).rejects.toThrow(/₹100 still refundable/);
  });

  it('a child booking of a master order shares the limit with master-level refunds (and is locked on the master)', async () => {
    const t = makeService({ order: { masterOrderId: 'mo-1' } });
    t.addRequest();
    await t.svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 100 });
    expect(t.prisma.refundRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ orderId: 'order-1' }, { masterOrderId: 'mo-1', orderId: null }] } }));
    expect(t.prisma.$queryRaw.mock.calls[0][1]).toBe('refund-booking:mo-1');
  });
});

describe('Partner recovery — explicit, capped, once (every route)', () => {
  it('needs a reason; never for a job the partner was not paid for', async () => {
    const t = makeService({ order: { status: 'CANCELLED', completedAt: null } });
    await expect(t.svc.recordPartnerRecovery('admin-1', { source: 'SUPPORT_CASE', sourceId: 'case-1', orderId: 'order-1', amount: 100, reason: '' })).rejects.toThrow(/reason/);
    await expect(t.svc.recordPartnerRecovery('admin-1', { source: 'SUPPORT_CASE', sourceId: 'case-1', orderId: 'order-1', amount: 100, reason: 'x' })).rejects.toThrow(/never paid/);
    expect(t.ledger.postEntry).not.toHaveBeenCalled();
  });

  it('capped by what the partner earned across ALL recoveries on the booking (cases + refund requests)', async () => {
    const t = makeService();
    t.addRequest();
    await t.svc.recordPartnerRecovery('admin-1', { source: 'SUPPORT_CASE', sourceId: 'case-1', orderId: 'order-1', amount: 600, reason: 'poor work' });
    await expect(t.svc.partnerRecoveryForRequest('admin-1', 'rr-1', 300, 'x')).rejects.toThrow(/₹800; ₹600 already recovered/);
    await t.svc.partnerRecoveryForRequest('admin-1', 'rr-1', 200, 'balance');
    expect(t.ledgerEntries.map((e) => e.amount)).toEqual([-600, -200]);
  });

  it('a retry posts nothing twice; a different amount for the same source is refused', async () => {
    const t = makeService();
    const input = { source: 'SUPPORT_CASE' as const, sourceId: 'case-1', orderId: 'order-1', amount: 150, reason: 'x' };
    expect(await t.svc.recordPartnerRecovery('admin-1', input)).toEqual(expect.objectContaining({ applied: true }));
    expect(await t.svc.recordPartnerRecovery('admin-1', input)).toEqual({ applied: false, alreadyApplied: true });
    await expect(t.svc.recordPartnerRecovery('admin-1', { ...input, amount: 200 })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.ledger.postEntry).toHaveBeenCalledTimes(1);
    expect(t.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PARTNER_RECOVERY' }) }));
  });
});
