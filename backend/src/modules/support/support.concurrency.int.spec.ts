import { PrismaClient } from '@prisma/client';
import { SupportCasesService, SupportPolicyEngine } from './support.module';
import { RefundsService } from '../refunds/refunds.module';
import { WalletService } from '../wallet/wallet.module';
import { PartnerLedgerService } from '../partner-ledger/partner-ledger.module';

/**
 * REAL-DATABASE financial-safety checks. Mocks cannot prove that a Postgres advisory lock, a
 * compare-and-swap claim or a unique constraint holds under truly parallel connections, so these
 * run the REAL RefundsService / WalletService / PartnerLedgerService against a THROWAWAY database
 * (only the payment gateway and notifications are faked — no network, no money). Set
 * INTEGRATION_DATABASE_URL to a database with this branch's schema pushed; skipped otherwise.
 * NEVER point this at production: it creates rows.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const d = url ? describe : describe.skip;

d('Refund & support-case safety under real concurrency (throwaway Postgres)', () => {
  let prisma: PrismaClient;
  let adminId: string; // a real User row — AuditLog.actorId is a foreign key
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    adminId = (await prisma.user.create({ data: { phone: `+9180${Date.now() % 100000000}`, name: 'int-admin', role: 'ADMIN' } as any })).id;
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  let seq = 0;
  async function seed(tag: string, order: Record<string, any> = {}) {
    seq += 1;
    const user = await prisma.user.create({ data: { phone: `+9170${(Date.now() % 10000000) * 10 + seq}`, name: `int-${tag}` } });
    const o = await prisma.order.create({
      data: {
        orderNumber: `INT-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, customerId: user.id, type: 'SERVICE',
        status: 'VENDOR_EN_ROUTE', paymentStatus: 'PAID', totalAmount: 1180, walletUsed: 0, arrivedAt: new Date(), ...order,
      } as any,
    });
    return { user, order: o };
  }

  /** Real services; `slow*` widens the claim windows so a missing lock WOULD show up (mutation-verified). */
  function makeServices(opts: { raiseFails?: boolean; slowCaseCount?: boolean; slowClaimRead?: boolean } = {}) {
    const db: any = opts.slowCaseCount
      ? prisma.$extends({ query: { supportCase: { async count({ args, query }: any) { await delay(60); return query(args); } } } })
      : opts.slowClaimRead
        ? prisma.$extends({ query: { refundRequest: { async findMany({ args, query }: any) { await delay(80); return query(args); } } } })
        : prisma;
    const calls = { raise: 0, compensate: 0, cancel: 0, gateway: 0 };
    const payments: any = {
      createRazorpayRefund: async (_p: string, amountPaise: number) => {
        calls.gateway += 1; await delay(30);
        return { ok: true, refund: { id: `rfnd_int_${Date.now()}_${calls.gateway}`, status: 'pending', amount: amountPaise } };
      },
    };
    const wallet = new WalletService(db, {} as any);
    const ledger = new PartnerLedgerService(db);
    const refunds = new RefundsService(db, payments, wallet, { refundProcessed: async () => {} } as any, ledger, { issueCreditNote: async () => null } as any);
    let raiseFailuresLeft = opts.raiseFails ? 1 : 0;
    const realRaise = refunds.raise.bind(refunds);
    (refunds as any).raise = async (...a: any[]) => {
      calls.raise += 1;
      await delay(30);
      if (raiseFailuresLeft > 0) { raiseFailuresLeft -= 1; throw new Error('gateway down'); }
      return (realRaise as any)(...a);
    };
    const admin: any = {
      postLedgerAdjustment: async () => { calls.compensate += 1; await delay(40); return {}; },
      adminCancelOrder: async (orderId: string) => { calls.cancel += 1; await delay(40); return prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } }); },
      forceAssignVendor: async () => ({}),
    };
    const support = new SupportCasesService(
      db, new SupportPolicyEngine(prisma as any), refunds, admin, { getWarrantyDefaults: async () => ({ days: 7, percent: 0 }) } as any,
      { supportCaseUpdate: async () => {} } as any, { create: async () => ({}) } as any, {} as any, {} as any,
    );
    return { support, refunds, calls };
  }
  const walletCredits = (orderId: string) => prisma.walletTransaction.count({ where: { orderId, type: 'CREDIT' } });
  const committedOnBooking = async (orderId: string) => (await prisma.refundRequest.findMany({ where: { orderId } }))
    .reduce((s, r) => s + Number(r.claimedAmount), 0);
  const newCase = (orderId: string, customerId: string, issueType: any, status: any = 'ADMIN_REVIEW') => prisma.supportCase.create({ data: {
    caseNumber: `INT-${issueType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, orderId, customerId,
    itemType: 'SERVICE', issueType, statusSnapshot: 'VENDOR_EN_ROUTE', routeType: 'SUPPORT_CASE', status,
  } });

  it('10 simultaneous cancellation requests open exactly ONE case', async () => {
    const { user, order } = await seed('m4');
    const { support } = makeServices({ slowCaseCount: true });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => support.requestCancellation(user.id, order.id, 'changed my mind')));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(new Set(results.map((r: any) => r.value.id)).size).toBe(1);
    expect(await prisma.supportCase.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('10 simultaneous admin decisions on one case → ONE refund, ONE wallet credit', async () => {
    const { user, order } = await seed('h2');
    const { support, calls } = makeServices();
    const kase = await support.requestCancellation(user.id, order.id, 'x');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => support.adminDecide(adminId, kase.id, 'FULL_REFUND', 1180, 'refund in full', { cancelOrder: true })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls.raise).toBe(1);
    expect(await walletCredits(order.id)).toBe(1);
    expect(Number((await prisma.supportCase.findUnique({ where: { id: kase.id } }))!.refundedTotal)).toBe(1180);
  });

  it('simultaneous decisions with compensation + cancellation apply each ONCE', async () => {
    const { user, order } = await seed('h2b');
    const { support, calls } = makeServices();
    const kase = await support.requestCancellation(user.id, order.id, 'x');
    await prisma.supportCase.update({ where: { id: kase.id }, data: { partnerId: 'vendor-int' } });
    await Promise.allSettled(Array.from({ length: 8 }, () => support.adminDecide(adminId, kase.id, 'PARTIAL_REFUND', 500, 'split', { partnerCompensation: 150, cancelOrder: true })));
    expect(calls.raise).toBe(1);
    expect(calls.cancel).toBe(1);
    expect(calls.compensate).toBe(1);
    expect(await walletCredits(order.id)).toBe(1);
  });

  it('a failed refund raise releases the case claim; the retry refunds exactly once', async () => {
    const { user, order } = await seed('h2c');
    const { support } = makeServices({ raiseFails: true });
    const kase = await support.requestCancellation(user.id, order.id, 'x');
    await expect(support.adminDecide(adminId, kase.id, 'FULL_REFUND', 1180, 'r', { cancelOrder: true })).rejects.toThrow('gateway down');
    const mid = await prisma.supportCase.findUnique({ where: { id: kase.id } });
    expect(Number(mid!.refundedTotal)).toBe(0);
    expect(mid!.status).toBe(kase.status);
    await support.adminDecide(adminId, kase.id, 'FULL_REFUND', 1180, 'r', { cancelOrder: true });
    expect(await walletCredits(order.id)).toBe(1);
  });

  it('a refund already processed outside the case (decided before this release) caps the decision', async () => {
    const { user, order } = await seed('m3');
    await prisma.refundRequest.create({ data: { customerId: user.id, orderId: order.id, reason: 'refunds screen', status: 'PROCESSED', approvedAmount: 1000 } });
    const { support } = makeServices();
    const kase = await support.requestCancellation(user.id, order.id, 'x');
    await expect(support.adminDecide(adminId, kase.id, 'FULL_REFUND', 1180, 'r', { cancelOrder: true })).rejects.toThrow(/only ₹180 is still refundable/);
    await support.adminDecide(adminId, kase.id, 'PARTIAL_REFUND', 180, 'r', { cancelOrder: true });
    expect(await walletCredits(order.id)).toBe(1);
  });

  it('two different cases on one booking, decided at the same moment, never refund more than was received', async () => {
    const { user, order } = await seed('xcase', { status: 'CANCELLED' });
    const { support } = makeServices({ slowClaimRead: true });
    const [a, b] = await Promise.all([newCase(order.id, user.id, 'PARTNER_ARRIVED'), newCase(order.id, user.id, 'PARTNER_ON_THE_WAY')]);
    const results = await Promise.allSettled([
      support.adminDecide(adminId, a.id, 'FULL_REFUND', 1180, 'case a'),
      support.adminDecide(adminId, b.id, 'FULL_REFUND', 1180, 'case b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await walletCredits(order.id)).toBe(1);
    expect(await committedOnBooking(order.id)).toBe(1180);
    // the refused case's claim was released and its undecided request withdrawn
    const cases = await prisma.supportCase.findMany({ where: { orderId: order.id } });
    expect(cases.reduce((s, c) => s + Number(c.refundedTotal), 0)).toBe(1180);
  });

  it('Admin › Refunds racing a support case on the SAME booking → one wins, never over the received amount', async () => {
    const { user, order } = await seed('race', { status: 'CANCELLED' });
    const { support, refunds } = makeServices({ slowClaimRead: true });
    const customerRequest = await prisma.refundRequest.create({ data: { customerId: user.id, orderId: order.id, reason: 'customer asked', status: 'UNDER_REVIEW' } });
    const kase = await newCase(order.id, user.id, 'PARTNER_ARRIVED');
    const results = await Promise.allSettled([
      refunds.decide(adminId, customerRequest.id, 'WALLET_CREDIT', { approvedAmount: 1000, adminNotes: 'refunds screen' }),
      support.adminDecide(adminId, kase.id, 'PARTIAL_REFUND', 1000, 'support case'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await committedOnBooking(order.id)).toBe(1000);
    expect(await walletCredits(order.id)).toBe(1);
  });

  it('a wallet credit can exist only once per refund request (database unique guard)', async () => {
    const { user, order } = await seed('uniq');
    const rr = await prisma.refundRequest.create({ data: { customerId: user.id, orderId: order.id, reason: 'x', status: 'UNDER_REVIEW' } });
    await prisma.refundWalletCredit.create({ data: { refundRequestId: rr.id } });
    await expect(prisma.refundWalletCredit.create({ data: { refundRequestId: rr.id } })).rejects.toMatchObject({ code: 'P2002' });
    // and a decision whose guard already exists posts no second credit
    const { refunds } = makeServices();
    await refunds.decide(adminId, rr.id, 'WALLET_CREDIT', { approvedAmount: 100 });
    expect(await walletCredits(order.id)).toBe(0);
  });

  it('simultaneous gateway decisions on one request → ONE provider refund, ONE key; accepted ≠ completed', async () => {
    const { user, order } = await seed('gw');
    await prisma.paymentTransaction.create({ data: { userId: user.id, orderId: order.id, amount: 1180, status: 'PAID', gateway: 'RAZORPAY', gatewayPaymentId: `pay_int_${Date.now()}` } as any });
    const { refunds, calls } = makeServices();
    const rr = await prisma.refundRequest.create({ data: { customerId: user.id, orderId: order.id, reason: 'x', status: 'UNDER_REVIEW' } });
    const results = await Promise.allSettled([1, 2, 3].map(() => refunds.decide(adminId, rr.id, 'GATEWAY_REFUND', { approvedAmount: 500 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(calls.gateway).toBe(1);
    const prs = await prisma.providerRefund.findMany({ where: { refundRequestId: rr.id } });
    expect(prs).toHaveLength(1);
    expect(prs[0].idempotencyKey).toBe(`rfnd_${rr.id}`);
    expect((await prisma.refundRequest.findUnique({ where: { id: rr.id } }))!.status).toBe('REFUND_PENDING');
  });

  it('partner recovery from two routes at once never exceeds what the partner earned', async () => {
    const vendorUser = await prisma.user.create({ data: { phone: `+9160${Date.now() % 100000000}`, name: 'int-partner' } });
    const vendor = await prisma.serviceVendor.create({ data: { userId: vendorUser.id, fullName: 'Int Partner', baseCity: 'Bhopal' } as any });
    const { user, order } = await seed('recov', { status: 'COMPLETED', completedAt: new Date(), vendorPayout: 800, vendorId: vendor.id });
    const { refunds } = makeServices({ slowClaimRead: true }); // widens the read→claim window (mutation-verified)
    const kase = await newCase(order.id, user.id, 'SERVICE_COMPLETED_ISSUE_NOT_FIXED');
    const rr = await prisma.refundRequest.create({ data: { customerId: user.id, orderId: order.id, reason: 'x', status: 'PROCESSED' } });
    const results = await Promise.allSettled([
      refunds.recordPartnerRecovery(adminId, { source: 'SUPPORT_CASE', sourceId: kase.id, orderId: order.id, amount: 500, reason: 'case' }),
      refunds.recordPartnerRecovery(adminId, { source: 'REFUND_REQUEST', sourceId: rr.id, orderId: order.id, amount: 500, reason: 'refund' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const entries = await prisma.partnerLedgerEntry.findMany({ where: { vendorId: vendor.id, orderId: order.id } });
    expect(entries.reduce((s, e) => s + Number(e.amount), 0)).toBe(-500);
  });
});
