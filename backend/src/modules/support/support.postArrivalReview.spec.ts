import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupportCasesService, SupportPolicyEngine } from './support.module';
import { RefundCapacityExceeded } from '../refunds/refunds.module';

/**
 * Post-arrival cancellation / refusal review on the EXISTING support-case workflow:
 * the partner can report a refusal (with fresh, server-verified arrival evidence), the customer
 * can request a cancellation, add their side and appeal once, and only an admin decision moves
 * money — refunds capped at what was actually paid, an appeal refunding only the difference,
 * partner compensation and order cancellation each applied at most once.
 */
const SERVICE = { id: 'svc-1', categoryId: 'cat-1', category: { warrantyDays: 7 } };
function makeOrder(o: any = {}) {
  return {
    id: 'order-1', orderNumber: 'REM-1', customerId: 'cust-1', vendorId: 'vendor-1', status: 'VENDOR_EN_ROUTE',
    paymentStatus: 'PAID', totalAmount: 1180, walletUsed: 0, dispatchAttempts: 0, createdAt: new Date(), completedAt: null,
    snapshotCity: 'Bhopal', snapshotLatitude: 23.2599, snapshotLongitude: 77.4126, arrivedAt: null,
    serviceId: SERVICE.id, service: SERVICE, items: [], ...o,
  };
}

function makeService(orderOverrides: any = {}, cancellationRules: any[] = []) {
  let order = makeOrder(orderOverrides);
  const cases = new Map<string, any>();
  let seq = 0;
  const prisma: any = {
    order: {
      findUnique: jest.fn(async () => order),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.arrivedAt === null && order.arrivedAt) return { count: 0 };
        order = { ...order, ...data };
        return { count: 1 };
      }),
    },
    orderTimeline: { create: jest.fn(async () => ({})) },
    serviceVendor: { findUnique: jest.fn(async ({ where }: any) => (where.userId === 'vendor-user-1' ? { id: 'vendor-1', userId: 'vendor-user-1' } : { id: 'vendor-2', userId: where.userId })) },
    user: { findUnique: jest.fn(async () => ({ phone: '9999999999' })) },
    city: { findFirst: jest.fn(async () => ({ id: 'city-bhopal' })) },
    commissionRule: { findMany: jest.fn(async ({ where }: any) => cancellationRules.filter((r) => r.ruleType === where.ruleType)) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    supportCase: {
      count: jest.fn(async () => seq),
      create: jest.fn(async ({ data }: any) => { seq += 1; const row = { id: `case-${seq}`, refundedTotal: 0, partnerCompensatedAt: null, partnerRecoveredAt: null, orderCancelledByCase: false, appealedAt: null, ...data }; cases.set(row.id, row); return row; }),
      findUnique: jest.fn(async ({ where }: any) => cases.get(where.id) || null),
      findMany: jest.fn(async ({ where }: any) => [...cases.values()].filter((c) => !where?.orderId || c.orderId === where.orderId)),
      findFirst: jest.fn(async ({ where }: any) => [...cases.values()].find((c) => c.orderId === where.orderId && c.issueType === where.issueType && where.status.in.includes(c.status)) || null),
      update: jest.fn(async ({ where, data }: any) => {
        const cur = cases.get(where.id);
        const next = { ...cur, ...data };
        if (data.refundedTotal && typeof data.refundedTotal === 'object') next.refundedTotal = Number(cur.refundedTotal || 0) + data.refundedTotal.increment;
        cases.set(where.id, next);
        return next;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const cur = cases.get(where.id);
        if (!cur) return { count: 0 };
        for (const [k, v] of Object.entries(where)) { if (k !== 'id' && cur[k] !== v) return { count: 0 }; }
        cases.set(where.id, { ...cur, ...data });
        return { count: 1 };
      }),
    },
    supportCaseLog: { create: jest.fn(async () => ({})) },
    auditLog: { create: jest.fn(async () => ({})) },
    refundRequest: { findMany: jest.fn(async () => []) },
    partnerLedgerEntry: { findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const policyEngine = new SupportPolicyEngine(prisma);
  // In-memory stand-in for RefundsService with the SAME booking-wide limit and once-only rules
  // (the real implementation is proven against Postgres in support.concurrency.int.spec.ts).
  const rrs: any[] = [];
  const outside: number[] = []; // refunds completed outside support cases (e.g. Admin › Refunds)
  const bookingState = () => {
    const received = (order.paymentStatus === 'PAID' ? Number(order.totalAmount) : 0) + Number(order.walletUsed || 0);
    const committed = rrs.reduce((s, r) => s + r.claimed, 0) + outside.reduce((s, a) => s + a, 0);
    return { received, committed, inFlight: 0, refundable: Math.max(0, Math.round((received - committed) * 100) / 100) };
  };
  const refunds: any = {
    outside,
    raise: jest.fn(async (_c: string, _o: string, _m: any, _r: string, _e: any, opts?: any) => { const r = { id: `rr-${rrs.length + 1}`, status: 'REQUESTED', claimed: 0, supportCaseId: opts?.supportCaseId }; rrs.push(r); return r; }),
    decide: jest.fn(async (_a: string, id: string, _m: string, o: any) => {
      const r = rrs.find((x) => x.id === id);
      const s = bookingState();
      if (o.approvedAmount > s.refundable) throw new RefundCapacityExceeded(`This refund (₹${o.approvedAmount}) exceeds the ₹${s.refundable} still refundable for this booking (received ₹${s.received}, already refunded or in progress ₹${s.committed})`);
      r.claimed = o.approvedAmount; r.status = 'PROCESSED';
      return r;
    }),
    bookingRefundState: jest.fn(async () => bookingState()),
    withdrawUndecided: jest.fn(async (id: string) => { const r = rrs.find((x) => x.id === id); if (r?.status === 'REQUESTED') r.status = 'REJECTED'; }),
    recordPartnerRecovery: jest.fn(async (_a: string, i: any) => {
      const k = cases.get(i.sourceId);
      if (k?.partnerRecoveredAt) return { applied: false, alreadyApplied: true };
      cases.set(i.sourceId, { ...k, partnerRecovery: i.amount, partnerRecoveredAt: new Date() });
      return { applied: true };
    }),
  };
  const admin: any = { postLedgerAdjustment: jest.fn(async () => ({})), adminCancelOrder: jest.fn(async () => { order = { ...order, status: 'CANCELLED' }; return {}; }), forceAssignVendor: jest.fn() };
  const ledger: any = { getWarrantyDefaults: jest.fn(async () => ({ days: 7, percent: 0 })) };
  const notifications: any = { create: jest.fn(async () => ({})) };
  const svc = new SupportCasesService(prisma, policyEngine, refunds, admin, ledger, { supportCaseUpdate: jest.fn(async () => {}) } as any, notifications, {} as any, {} as any);
  return { svc, prisma, refunds, admin, notifications, cases, get order() { return order; } };
}
const CHARGE_300 = { id: 'cc-300', ruleType: 'CANCELLATION_CHARGE', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'FLAT', value: 300, slabJson: null, priority: 0, stackable: false, isActive: true };
const AT_ADDRESS = { latitude: 23.2601, longitude: 77.4127, accuracyM: 12 };

describe('Partner reports the customer refused the service', () => {
  it('records server-verified arrival evidence and opens an ADMIN_REVIEW case — no money moves', async () => {
    const t = makeService({}, [CHARGE_300]);
    const kase = await t.svc.partnerReportRefusal('vendor-user-1', 'order-1', { reasonCode: 'CUSTOMER_REFUSED', remarks: 'Customer said not needed', ...AT_ADDRESS } as any);
    expect(kase.status).toBe('ADMIN_REVIEW');
    expect(kase.openedByRole).toBe('SERVICE_VENDOR');
    expect(kase.issueType).toBe('CUSTOMER_REFUSED_SERVICE');
    expect(Number(kase.recommendedAmount)).toBe(880); // ₹1180 paid − configured ₹300 — a recommendation only
    expect(t.order.arrivalVerification).toBe('VERIFIED');
    expect(t.order.arrivalDistanceM).toBeLessThan(50);
    expect(t.refunds.raise).not.toHaveBeenCalled();
    expect(t.notifications.create).toHaveBeenCalledWith('cust-1', expect.objectContaining({ title: expect.any(String) }));
  });

  it('a second submit returns the same open case (no duplicate case, arrival recorded once)', async () => {
    const t = makeService();
    const a = await t.svc.partnerReportRefusal('vendor-user-1', 'order-1', { reasonCode: 'CUSTOMER_CHANGED_MIND', ...AT_ADDRESS } as any);
    const b = await t.svc.partnerReportRefusal('vendor-user-1', 'order-1', { reasonCode: 'CUSTOMER_CHANGED_MIND', ...AT_ADDRESS } as any);
    expect(b.id).toBe(a.id);
    expect(t.cases.size).toBe(1);
    expect(t.prisma.orderTimeline.create).toHaveBeenCalledTimes(1);
  });

  it('GPS failure is stored as NOT verified — never fabricated', async () => {
    const t = makeService();
    await t.svc.partnerReportRefusal('vendor-user-1', 'order-1', { reasonCode: 'CUSTOMER_REFUSED', locationError: 'PERMISSION_DENIED' } as any);
    expect(t.order.arrivalVerification).toBe('NOT_VERIFIED_NO_LOCATION');
    expect(t.order.arrivalLatitude).toBeNull();
    expect(t.order.arrivalNote).toBe('PERMISSION_DENIED');
  });

  it('only the assigned partner, only before the job starts, "Other" needs remarks', async () => {
    await expect(makeService().svc.partnerReportRefusal('someone-else', 'order-1', { reasonCode: 'CUSTOMER_REFUSED' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService({ status: 'STARTED' }).svc.partnerReportRefusal('vendor-user-1', 'order-1', { reasonCode: 'CUSTOMER_REFUSED' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(makeService().svc.partnerReportRefusal('vendor-user-1', 'order-1', { reasonCode: 'OTHER' } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Customer cancels after the partner arrived', () => {
  it('opens a review case (PARTNER_ARRIVED) — no instant cancellation and no automatic deduction', async () => {
    const t = makeService({ arrivedAt: new Date(), arrivalVerification: 'VERIFIED' }, [CHARGE_300]);
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'Plans changed');
    expect(kase.issueType).toBe('PARTNER_ARRIVED');
    expect(kase.routeType).toBe('SUPPORT_CASE');
    expect(kase.status).toBe('OPEN');
    expect(t.refunds.raise).not.toHaveBeenCalled();
    expect(t.admin.adminCancelOrder).not.toHaveBeenCalled();
  });

  it('before arrival the customer is told to cancel directly; repeat requests reuse the open case', async () => {
    await expect(makeService().svc.requestCancellation('cust-1', 'order-1', 'x')).rejects.toBeInstanceOf(BadRequestException);
    const t = makeService({ arrivedAt: new Date() });
    const a = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    const b = await t.svc.requestCancellation('cust-1', 'order-1', 'again');
    expect(b.id).toBe(a.id);
  });

  it('an unpaid (cash) booking recommends no refund of money never collected', async () => {
    const t = makeService({ arrivedAt: new Date(), paymentStatus: 'PENDING' });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    expect(Number(kase.recommendedAmount)).toBe(0);
  });

  it('the customer can add their side while it is open', async () => {
    const t = makeService({ arrivedAt: new Date() });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    const updated = await t.svc.customerRespond('cust-1', kase.id, 'The partner arrived 2 hours late');
    expect(updated.customerStatement).toBe('The partner arrived 2 hours late');
    await expect(t.svc.customerRespond('cust-2', kase.id, 'x')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Admin decision, appeal, compensation — each applied at most once', () => {
  async function decidedCase(amount = 880, opts: any = {}) {
    const t = makeService({ arrivedAt: new Date() }, [CHARGE_300]);
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    // the approved workflow: cancellation first, then the refund
    await t.svc.adminDecide('admin-1', kase.id, 'REFUND_MINUS_VISIT', amount, 'Charge approved', { cancelOrder: true, ...opts });
    return { t, kase };
  }

  it('the refund can never exceed what the customer actually paid', async () => {
    const t = makeService({ arrivedAt: new Date() });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 5000, 'x', { cancelOrder: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.refunds.raise).not.toHaveBeenCalled();
  });

  it('an appeal refunds only the difference; a second appeal is refused', async () => {
    const { t, kase } = await decidedCase(880);
    expect(t.refunds.decide).toHaveBeenLastCalledWith('admin-1', expect.any(String), 'WALLET_CREDIT', expect.objectContaining({ approvedAmount: 880 }));
    await t.svc.customerAppeal('cust-1', kase.id, 'The partner was very late');
    expect(t.cases.get(kase.id).status).toBe('ADMIN_REVIEW');
    await t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'Appeal accepted — no charge');
    expect(t.refunds.decide).toHaveBeenCalledTimes(2);
    expect(t.refunds.decide).toHaveBeenLastCalledWith('admin-1', expect.any(String), 'WALLET_CREDIT', expect.objectContaining({ approvedAmount: 300 }));
    expect(Number(t.cases.get(kase.id).refundedTotal)).toBe(1180);
    await expect(t.svc.customerAppeal('cust-1', kase.id, 'again')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('partner compensation is posted once through the audited ledger adjustment; a repeat never posts again', async () => {
    const { t, kase } = await decidedCase(880, { partnerCompensation: 150 });
    expect(t.admin.postLedgerAdjustment).toHaveBeenCalledTimes(1);
    expect(t.admin.postLedgerAdjustment).toHaveBeenCalledWith('vendor-1', 150, expect.stringContaining(kase.caseNumber), 'admin-1');
    await t.svc.customerAppeal('cust-1', kase.id, 'x');
    // a different amount is refused outright …
    await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { partnerCompensation: 200 })).rejects.toBeInstanceOf(BadRequestException);
    // … and the same amount (e.g. a retry) is an idempotent no-op — never a second posting
    await t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { partnerCompensation: 150 });
    expect(t.admin.postLedgerAdjustment).toHaveBeenCalledTimes(1);
  });

  it('a failed ledger post releases the claim so a retry is safe', async () => {
    const t = makeService({ arrivedAt: new Date() });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    t.admin.postLedgerAdjustment.mockRejectedValueOnce(new Error('db down'));
    await expect(t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'x', { partnerCompensation: 100 })).rejects.toThrow('db down');
    expect(t.cases.get(kase.id).partnerCompensatedAt).toBeNull();
  });

  it('the booking is cancelled through the existing admin cancel exactly once', async () => {
    const { t, kase } = await decidedCase(880, { cancelOrder: true });
    expect(t.admin.adminCancelOrder).toHaveBeenCalledTimes(1);
    await t.svc.customerAppeal('cust-1', kase.id, 'x');
    await t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true });
    expect(t.admin.adminCancelOrder).toHaveBeenCalledTimes(1);
  });

  it('compensation/cancellation are refused on non-cancellation cases', async () => {
    const t = makeService({ status: 'COMPLETED', completedAt: new Date() });
    const kase = await t.svc.openCase('cust-1', { orderId: 'order-1', issueType: 'OTHER_ISSUE' as any });
    await expect(t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'x', { partnerCompensation: 10 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Audit fixes — refund cap (M3), wallet portion (M3), one decision at a time (H2), one open case (M4)', () => {
  it('M3: refunds already processed OUTSIDE the case (Refunds screen, other cases) reduce what can be refunded', async () => {
    const t = makeService({ arrivedAt: new Date() });
    t.refunds.outside.push(1000); // refunded earlier through Admin › Refunds
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true })).rejects.toThrow(/only ₹180 is still refundable \(paid ₹1180, already refunded ₹1000\)/);
    await t.svc.adminDecide('admin-1', kase.id, 'PARTIAL_REFUND', 180, 'x', { cancelOrder: true });
    expect(t.refunds.raise).toHaveBeenCalledTimes(1);
  });

  it('M3: a master-order-level refund is subtracted in full (conservative — never over-refund)', async () => {
    const t = makeService({ arrivedAt: new Date(), masterOrderId: 'mo-1' });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await t.svc.adminDecide('admin-1', kase.id, 'PARTIAL_REFUND', 100, 'x', { cancelOrder: true });
    // the booking-wide limit (incl. master-order refunds) comes from the ONE shared boundary
    expect(t.refunds.bookingRefundState).toHaveBeenCalledWith(expect.anything(), { orderId: 'order-1' });
  });

  it('M3: an unpaid (cash) booking refunds only its wallet portion, through the wallet-portion path', async () => {
    const t = makeService({ arrivedAt: new Date(), paymentStatus: 'PENDING', totalAmount: 1080, walletUsed: 100 });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 101, 'x', { cancelOrder: true })).rejects.toThrow(/only ₹100 is still refundable/);
    await t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 100, 'x', { cancelOrder: true });
    expect(t.refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.any(String), [], expect.objectContaining({ allowWalletPortion: true, supportCaseId: kase.id }));
  });

  it('H2: five simultaneous decisions on one case → one refund, the rest are told to reload', async () => {
    const t = makeService({ arrivedAt: new Date() });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.refunds.raise).toHaveBeenCalledTimes(1);
    expect(t.refunds.decide).toHaveBeenCalledTimes(1);
  });

  it('H2: a refund that fails AFTER it was raised keeps the claim — a retry never raises a second refund', async () => {
    const t = makeService({ arrivedAt: new Date() });
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    t.refunds.decide.mockRejectedValueOnce(new Error('wallet service timeout'));
    await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true })).rejects.toThrow(/finish refund request .* from Admin › Refunds/);
    expect(Number(t.cases.get(kase.id).refundedTotal)).toBe(1180); // claim kept (fail closed)
    expect(t.cases.get(kase.id).status).toBe(kase.status);           // case re-opened for the admin
    await t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true });
    expect(t.refunds.raise).toHaveBeenCalledTimes(1);
  });

  it('M4: cancellation cases are created inside a transaction holding a per-order advisory lock', async () => {
    const t = makeService({ arrivedAt: new Date() });
    await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    expect(t.prisma.$transaction).toHaveBeenCalled();
    const lockSql = t.prisma.$queryRaw.mock.calls[0];
    expect(lockSql[0].join('?')).toContain('pg_advisory_xact_lock(hashtext(');
    expect(lockSql[1]).toBe('support-case-open:order-1:PARTNER_ARRIVED');
  });
});

describe('Approved business rules — penalty preview, start OTP, admin workflow, partner ledger, refund safety', () => {
  const PCT_10_MIN_199 = { ...CHARGE_300, id: 'pen-pct', commissionType: 'PERCENTAGE', value: 10, minimumAmount: 199 };

  describe('A — the customer sees the cancellation calculation before confirming', () => {
    it('prepaid, partner arrived: 10% of ₹1000 with ₹199 minimum → penalty ₹199, estimated refund ₹981', async () => {
      const t = makeService({ arrivedAt: new Date(), serviceAmount: 1000 }, [PCT_10_MIN_199]);
      const p: any = await t.svc.cancellationPreview('cust-1', 'order-1');
      expect(p).toEqual(expect.objectContaining({ stage: 'PARTNER_ARRIVED', canRequestCancellation: true, paid: 1180, estimatedRefund: 981 }));
      expect(p.penalty).toEqual(expect.objectContaining({ amount: 199, percent: 10, percentAmount: 100, minimum: 199 }));
    });
    it('unpaid (cash) with ₹100 from the wallet: never refunds money not received — estimated refund ₹0', async () => {
      const t = makeService({ arrivedAt: new Date(), serviceAmount: 1000, paymentStatus: 'PENDING', totalAmount: 1080, walletUsed: 100 }, [PCT_10_MIN_199]);
      const p: any = await t.svc.cancellationPreview('cust-1', 'order-1');
      expect(p.paid).toBe(100);
      expect(p.estimatedRefund).toBe(0);
    });
    it('before arrival: no penalty, direct cancel', async () => {
      const t = makeService({ arrivedAt: null }, [PCT_10_MIN_199]);
      expect(await t.svc.cancellationPreview('cust-1', 'order-1')).toEqual(expect.objectContaining({ stage: 'BEFORE_ARRIVAL', canCancelDirectly: true, penalty: null }));
    });
    it("another customer cannot preview someone else's booking", async () => {
      const t = makeService({ arrivedAt: new Date() });
      await expect(t.svc.cancellationPreview('someone-else', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('B — once the START OTP is shared, self-service cancellation closes; complaints stay open', () => {
    it('preview says complaint-only', async () => {
      const t = makeService({ arrivedAt: new Date(), startOtpVerified: true, status: 'STARTED' });
      expect(await t.svc.cancellationPreview('cust-1', 'order-1')).toEqual(expect.objectContaining({ stage: 'SERVICE_STARTED', complaintOnly: true, canRequestCancellation: false }));
    });
    it('a cancellation request is refused with SERVICE_STARTED (also when only the OTP flag is set)', async () => {
      const t = makeService({ arrivedAt: new Date(), startOtpVerified: true });
      const err: any = await t.svc.requestCancellation('cust-1', 'order-1', 'x').catch((e) => e);
      expect(err.getResponse().error).toBe('SERVICE_STARTED');
      expect(t.cases.size).toBe(0);
    });
    it('a cancellation-type case is refused, but a complaint about the service is accepted', async () => {
      const t = makeService({ arrivedAt: new Date(), startOtpVerified: true, status: 'STARTED' });
      await expect(t.svc.openCase('cust-1', { orderId: 'order-1', issueType: 'PARTNER_ARRIVED' })).rejects.toThrow(/start OTP/);
      const complaint: any = await t.svc.openCase('cust-1', { orderId: 'order-1', issueType: 'SERVICE_STARTED_ISSUE', description: 'work left half done' });
      expect(complaint.issueType).toBe('SERVICE_STARTED_ISSUE');
      expect(t.refunds.raise).not.toHaveBeenCalled(); // a request alone never refunds
    });
  });

  describe('C / workflow — the admin decides; each step is explicit', () => {
    it('a refund on a cancellation request needs the cancellation approved first', async () => {
      const t = makeService({ arrivedAt: new Date() });
      const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 500, 'x')).rejects.toThrow(/Approve the cancellation first/);
      expect(t.refunds.raise).not.toHaveBeenCalled();
    });
    it('"continue the service": no cancellation, no refund, decision + reason recorded and audited', async () => {
      const t = makeService({ arrivedAt: new Date() });
      const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      const res: any = await t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'Customer agreed to continue');
      expect(res.status).toBe('RESOLVED');
      expect(res.resolutionReason).toBe('Customer agreed to continue');
      expect(t.admin.adminCancelOrder).not.toHaveBeenCalled();
      expect(t.refunds.raise).not.toHaveBeenCalled();
      expect(t.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'SUPPORT_CASE_RESOLVED' }) }));
    });
    it('"assign another technician" uses the existing reassignment; cancel + reassign together is refused', async () => {
      const t = makeService({ arrivedAt: new Date() });
      const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      await expect(t.svc.adminDecide('admin-1', kase.id, 'REASSIGN_PARTNER', undefined, 'x', { cancelOrder: true, newVendorId: 'v2' })).rejects.toThrow(/Choose one/);
      await t.svc.adminDecide('admin-1', kase.id, 'REASSIGN_PARTNER', undefined, 'Partner unwell', { newVendorId: 'vendor-2' });
      expect(t.admin.forceAssignVendor).toHaveBeenCalledWith('order-1', 'vendor-2', 'admin-1', 'ADMIN');
    });
    it('an issue during the service can be part-refunded while the service continues (no cancellation needed)', async () => {
      const t = makeService({ arrivedAt: new Date(), startOtpVerified: true, status: 'STARTED' });
      const kase: any = await t.svc.openCase('cust-1', { orderId: 'order-1', issueType: 'SERVICE_STARTED_ISSUE' });
      await t.svc.adminDecide('admin-1', kase.id, 'PARTIAL_REFUND', 200, 'Goodwill — minor damage');
      expect(t.refunds.raise).toHaveBeenCalledTimes(1);
      expect(t.admin.adminCancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('Partner ledger — recovery is a separate, explicit decision, never automatic', () => {
    it('a partner who was never paid (job not completed) cannot be charged', async () => {
      const t = makeService({ arrivedAt: new Date(), vendorPayout: 800 });
      const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      await expect(t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'x', { partnerRecovery: 100 })).rejects.toThrow(/never paid/);
      expect(t.refunds.recordPartnerRecovery).not.toHaveBeenCalled();
    });
    it('completed job: recovery posts one NEGATIVE adjustment, separate from any refund; a repeat never posts again', async () => {
      const t = makeService({ status: 'COMPLETED', completedAt: new Date(), vendorPayout: 800 });
      const kase: any = await t.svc.openCase('cust-1', { orderId: 'order-1', issueType: 'SERVICE_COMPLETED_ISSUE_NOT_FIXED' });
      await t.prisma.supportCase.update({ where: { id: kase.id }, data: { status: 'ADMIN_REVIEW' } });
      await expect(t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'x', { partnerRecovery: 900 })).rejects.toThrow(/cannot exceed the ₹800/);
      await t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'Poor workmanship', { partnerRecovery: 150 });
      // the shared, atomic recovery rule (claim + ledger debit + audit in one transaction)
      expect(t.refunds.recordPartnerRecovery).toHaveBeenCalledTimes(1);
      expect(t.refunds.recordPartnerRecovery).toHaveBeenCalledWith('admin-1', expect.objectContaining({ source: 'SUPPORT_CASE', orderId: 'order-1', amount: 150 }));
      expect(t.admin.postLedgerAdjustment).not.toHaveBeenCalled();
    });
    it('every refund raised by a case is tagged with it (so the refund pipeline never auto-charges the partner)', async () => {
      const t = makeService({ arrivedAt: new Date() });
      const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      await t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true });
      expect(t.refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.any(String), [], expect.objectContaining({ supportCaseId: kase.id }));
    });
  });

  describe('Refund safety across cases of the same booking + reconciliation', () => {
    it('two cases on one booking can never refund more than was paid in total', async () => {
      const t = makeService({ arrivedAt: new Date() });
      const a = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      await t.svc.adminDecide('admin-1', a.id, 'PARTIAL_REFUND', 1000, 'x', { cancelOrder: true });
      const b = await t.prisma.supportCase.create({ data: { orderId: 'order-1', customerId: 'cust-1', issueType: 'PARTNER_ON_THE_WAY', itemType: 'SERVICE', status: 'ADMIN_REVIEW', caseNumber: 'SUP-B', evidenceUrls: [] } });
      await expect(t.svc.adminDecide('admin-1', b.id, 'PARTIAL_REFUND', 500, 'x')).rejects.toThrow(/only ₹180 is still refundable/);
      await t.svc.adminDecide('admin-1', b.id, 'PARTIAL_REFUND', 180, 'x');
      expect(t.refunds.raise).toHaveBeenCalledTimes(2);
    });
    it("reconcile: refused while the case's refund request is still open; then aligns to what was actually refunded", async () => {
      const t = makeService({ arrivedAt: new Date() });
      const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
      t.refunds.decide.mockRejectedValueOnce(new Error('wallet down'));
      await expect(t.svc.adminDecide('admin-1', kase.id, 'FULL_REFUND', 1180, 'x', { cancelOrder: true })).rejects.toThrow(/Admin › Refunds/);
      t.prisma.refundRequest.findMany.mockResolvedValueOnce([{ id: 'rr-1', status: 'UNDER_REVIEW', approvedAmount: null }]);
      await expect(t.svc.reconcileRefundClaim('admin-1', kase.id)).rejects.toThrow(/still open/);
      // the admin then completed it in Admin › Refunds for ₹1000 instead
      t.prisma.refundRequest.findMany.mockResolvedValueOnce([{ id: 'rr-1', status: 'PROCESSED', approvedAmount: 1000 }]);
      expect(await t.svc.reconcileRefundClaim('admin-1', kase.id)).toEqual({ before: 1180, after: 1000, changed: true });
      expect(Number(t.cases.get(kase.id).refundedTotal)).toBe(1000);
    });
  });
});

describe('COD / unpaid cancellation penalty — retained vs pending collection, never charged', () => {
  const FLAT_199 = { ...CHARGE_300, id: 'pen-199', value: 199 };
  it('unpaid cash booking with ₹100 wallet: ₹199 approved → ₹100 retained, ₹99 pending collection (no charge, no refund)', async () => {
    const t = makeService({ arrivedAt: new Date(), paymentStatus: 'PENDING', totalAmount: 1080, walletUsed: 100 }, [FLAT_199]);
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'Late cancellation — penalty applies', { cancelOrder: true, penaltyAmount: 199 });
    const c = t.cases.get(kase.id);
    expect(Number(c.penaltyAssessed)).toBe(199);
    expect(Number(c.penaltyRetained)).toBe(100);
    expect(Number(c.penaltyPendingCollection)).toBe(99);
    expect(t.refunds.raise).not.toHaveBeenCalled(); // nothing is charged or deducted automatically
  });
  it('prepaid: penalty fully retained from the unrefunded payment', async () => {
    const t = makeService({ arrivedAt: new Date() }, [FLAT_199]);
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await t.svc.adminDecide('admin-1', kase.id, 'REFUND_MINUS_VISIT', 981, 'x', { cancelOrder: true, penaltyAmount: 199 });
    const c = t.cases.get(kase.id);
    expect([Number(c.penaltyRetained), Number(c.penaltyPendingCollection)]).toEqual([199, 0]);
  });
  it('never above the configured rule, never without a rule, never without the cancellation', async () => {
    const t = makeService({ arrivedAt: new Date() }, [FLAT_199]);
    const kase = await t.svc.requestCancellation('cust-1', 'order-1', 'x');
    await expect(t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'x', { cancelOrder: true, penaltyAmount: 250 })).rejects.toThrow(/cannot exceed the configured ₹199/);
    await expect(t.svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'x', { penaltyAmount: 100 })).rejects.toThrow(/only when the booking is cancelled/);
    const u = makeService({ arrivedAt: new Date() }, []);
    const k2 = await u.svc.requestCancellation('cust-1', 'order-1', 'x');
    await expect(u.svc.adminDecide('admin-1', k2.id, 'NO_REFUND', undefined, 'x', { cancelOrder: true, penaltyAmount: 50 })).rejects.toThrow(/No cancellation penalty is configured/);
  });
});
