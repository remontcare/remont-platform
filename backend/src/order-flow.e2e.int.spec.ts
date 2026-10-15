/* eslint-disable @typescript-eslint/no-var-requires */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

/**
 * END-TO-END order & payment flow — boots the REAL backend application (every module, guard,
 * validation pipe, event listener and scheduled job) on a random local port against a THROWAWAY
 * database, and drives it over HTTP exactly as the website and the partner apps do. The only
 * thing replaced is Razorpay's network client (a local fake: create order / fetch payment), so no
 * real money can move. Customer/partner/admin sessions are JWTs signed with the test secret for
 * verified accounts — the same tokens OTP login issues.
 *
 * Runs only with E2E_DATABASE_URL pointing at the local throwaway cluster (localhost:55432).
 */
const url = process.env.E2E_DATABASE_URL || '';
const d = /localhost:55432/.test(url) ? describe : describe.skip;
jest.setTimeout(240_000);

const JWT_SECRET = 'e2e-jwt-secret';
const KEY_SECRET = 'e2e-razorpay-key-secret';
const WEBHOOK_SECRET = 'e2e-razorpay-webhook-secret';
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('ORDER & PAYMENT FLOW — full application over HTTP (throwaway DB, fake gateway)', () => {
  let app: any;
  let base = '';
  let prisma: PrismaClient;
  const rz = { orders: new Map<string, any>(), payments: new Map<string, any>() };
  const ids: Record<string, any> = {};
  let seq = 0;
  const phone = () => `+9166${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
  const token = (u: { id: string; phone: string; role: string }) => jwt.sign({ sub: u.id, phone: u.phone, role: u.role }, JWT_SECRET, { expiresIn: '1h' });

  async function api(method: string, path: string, opts: { as?: any; body?: any; headers?: Record<string, string>; rawBody?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (opts.as) headers.Authorization = `Bearer ${token(opts.as)}`;
    const res = await fetch(base + path, { method, headers, body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, data: json && typeof json === 'object' && 'data' in json ? json.data : json, raw: json };
  }
  /** The customer pays in the Razorpay checkout: the fake gateway records a captured payment. */
  function customerPays(gatewayOrderId: string, amountPaise?: number) {
    const pid = `pay_${crypto.randomBytes(6).toString('hex')}`;
    const order = rz.orders.get(gatewayOrderId);
    rz.payments.set(pid, { id: pid, order_id: gatewayOrderId, status: 'captured', amount: amountPaise ?? order.amount, fee: 236, tax: 36 });
    const signature = crypto.createHmac('sha256', KEY_SECRET).update(`${gatewayOrderId}|${pid}`).digest('hex');
    return { paymentId: pid, signature };
  }
  async function webhook(event: string, entity: any) {
    const rawBody = JSON.stringify({ event, payload: { payment: { entity } } });
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    return api('POST', '/payments/webhook', { rawBody, headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': `evt_${crypto.randomBytes(5).toString('hex')}` } });
  }
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, label: string, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    let v = await fn();
    while (!ok(v)) { if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(250); v = await fn(); }
    return v;
  }
  const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const vendorRow = (id: string) => prisma.serviceVendor.findUniqueOrThrow({ where: { id } });

  async function mkUser(role: string, extra: any = {}) {
    return prisma.user.create({ data: { phone: phone(), name: `${role} ${seq}`, role, isVerified: true, ...extra } as any });
  }
  async function mkPartner(skill: string) {
    const u = await mkUser('SERVICE_VENDOR');
    const v = await prisma.serviceVendor.create({ data: {
      userId: u.id, fullName: `Partner ${seq}`, businessName: `Partner ${seq}`, baseCity: 'Bhopal', staffType: 'PARTNER',
      status: 'ACTIVE', isOnline: true, skills: [skill], serviceRadius: 25,
    } as any });
    return { user: u, vendor: v };
  }
  const cartBody = (items: any[], extra: any = {}) => ({
    name: 'E2E Customer', phone: extra.phone || phone(), items, fullAddress: '12 Test Road, Arera Colony', city: 'Bhopal', state: 'Madhya Pradesh',
    pincode: '462016', latitude: 23.2156, longitude: 77.4304, idempotencyKey: `idem-${crypto.randomBytes(6).toString('hex')}`, ...extra,
  });

  /** The partner side of a job, through the partner API: accept → en route → arrive → start OTP → complete. */
  async function partnerRunsJob(orderId: string, p: { user: any; vendor: any }, completeExtra: any = {}) {
    await until(() => order(orderId), (o) => o.dispatchAttempts >= 1, 'dispatch');
    const acc = await api('POST', `/vendors/service/me/jobs/${orderId}/accept`, { as: p.user });
    if (acc.status >= 300) throw new Error('accept failed: ' + JSON.stringify(acc.raw));
    expect((await api('PATCH', `/orders/${orderId}/en-route`, { as: p.user })).status).toBeLessThan(300);
    expect((await api('PATCH', `/orders/${orderId}/arrived`, { as: p.user, body: { latitude: 23.2156, longitude: 77.4304, accuracyM: 12 } })).status).toBeLessThan(300);
    const o1 = await order(orderId);
    expect((await api('POST', `/orders/${orderId}/verify-otp`, { as: p.user, body: { otp: o1.startOtp } })).status).toBeLessThan(300);
    const balance = await api('GET', `/orders/${orderId}/balance`, { as: p.user });
    const o2 = await order(orderId);
    const done = await api('POST', `/orders/${orderId}/complete`, { as: p.user, body: { otp: o2.endOtp, photosAfter: [], ...completeExtra } });
    return { balance: balance.data, complete: done };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url, NODE_ENV: 'test', JWT_SECRET, JWT_REFRESH_SECRET: 'e2e-refresh',
      RAZORPAY_KEY_ID: 'rzp_test_e2e', RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      FRONTEND_URL: 'http://localhost:3000',
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('./app.module');
    const { configureHttpApp } = require('./app.setup');
    // exactly what main.ts runs
    app = await NestFactory.create(AppModule, { rawBody: true, bodyParser: true, logger: ['error'] });
    configureHttpApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;

    // The only stand-in: Razorpay's network client.
    const { PaymentsService } = require('./modules/payments/payments.module');
    const payments = app.get(PaymentsService);
    payments.razorpay = {
      orders: { create: async (o: any) => { const id = `order_${crypto.randomBytes(6).toString('hex')}`; rz.orders.set(id, { ...o, id }); return { id, amount: o.amount, currency: 'INR' }; } },
      payments: {
        fetch: async (pid: string) => { const p = rz.payments.get(pid); if (!p) throw new Error('not found'); return p; },
        refund: async () => { throw new Error('gateway refunds are not used in this test'); },
      },
    };
    payments.razorpayKeyId = 'rzp_test_e2e';
    payments.razorpayKeySecret = KEY_SECRET;
    payments.razorpayWebhookSecret = WEBHOOK_SECRET;
    payments.activeGateway = 'RAZORPAY';

    // Catalogue & people (fresh synthetic data)
    const tag = Date.now().toString(36).toUpperCase();
    ids.city = await prisma.city.upsert({ where: { name: 'Bhopal' }, update: { isActive: true }, create: { name: 'Bhopal', state: 'Madhya Pradesh', latitude: 23.2599, longitude: 77.4126, isActive: true } as any }).catch(async () => prisma.city.findFirst({ where: { name: 'Bhopal' } }));
    ids.catA = await prisma.serviceCategory.create({ data: { key: `E2EA${tag}`, name: 'Electrical E2E', icon: 'x', slug: `e2e-a-${tag.toLowerCase()}` } as any });
    ids.catB = await prisma.serviceCategory.create({ data: { key: `E2EB${tag}`, name: 'Plumbing E2E', icon: 'x', slug: `e2e-b-${tag.toLowerCase()}` } as any });
    ids.svcA = await prisma.service.create({ data: { categoryId: ids.catA.id, name: 'Fan installation', slug: `e2e-fan-${tag.toLowerCase()}`, basePrice: 500, hsnSac: '998719', isActive: true } as any });
    ids.svcB = await prisma.service.create({ data: { categoryId: ids.catB.id, name: 'Tap repair', slug: `e2e-tap-${tag.toLowerCase()}`, basePrice: 300, hsnSac: '998719', isActive: true } as any });
    for (const cat of [ids.catA, ids.catB]) {
      await prisma.commissionRule.create({ data: { ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: cat.id, commissionType: 'PERCENTAGE', value: 20, isActive: true } as any });
    }
    ids.pA = await mkPartner(`E2EA${tag}`);
    ids.pB = await mkPartner(`E2EB${tag}`);
    ids.admin = await mkUser('SUPER_ADMIN');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  // ── 1 + 7 + 12: single service, logged-in customer, paid online; arrival/start/completion ──
  it('1/7/12. service booked and paid online → dispatched → partner arrives, starts, completes → nothing to collect, earnings posted, invoice issued', async () => {
    const cust = await mkUser('CUSTOMER');
    const created = await api('POST', '/orders', { as: cust, body: { type: 'SERVICE', serviceId: ids.svcA.id, inlineAddress: { fullAddress: '1 Lake View', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462001', latitude: 23.2156, longitude: 77.4304 } } });
    expect(created.status).toBe(201);
    const o = created.data;
    expect(Number(o.totalAmount)).toBe(590); // 500 + 18% GST
    // the app creates the gateway order for its own order only
    const stranger = await mkUser('CUSTOMER');
    expect((await api('POST', '/payments/create-order', { as: stranger, body: { amount: 590, orderId: o.id } })).status).toBe(403);
    const rzo = await api('POST', '/payments/create-order', { as: cust, body: { amount: 590, orderId: o.id } });
    expect(rzo.status).toBe(201);
    const pay = customerPays(rzo.data.id || rzo.data.gatewayOrderId);
    const conf = await api('POST', `/orders/${o.id}/confirm-payment`, { as: cust, body: { paymentId: pay.paymentId, gatewayOrderId: rzo.data.id || rzo.data.gatewayOrderId, signature: pay.signature } });
    expect(conf.status).toBe(201);
    expect((await order(o.id)).paymentStatus).toBe('PAID');

    const run = await partnerRunsJob(o.id, ids.pA);
    expect(run.balance.balanceDue).toBe(0); // the partner is never asked for money already paid
    expect(run.complete.status).toBe(201);
    const after = await order(o.id);
    expect(after.earningsStatus).toBe('POSTED');
    expect(after.arrivedAt).toBeTruthy();
    const ledger = await prisma.partnerLedgerEntry.findMany({ where: { orderId: o.id } });
    expect(ledger.filter((e) => e.type === 'JOB_EARNING')).toHaveLength(1);
    // economics: 500 − 20% commission = 400 (lead cost at accept is part of the commission; a warranty hold only defers)
    expect(r2(ledger.filter((e) => !['HOLD', 'HOLD_RELEASE'].includes(e.type)).reduce((a, e) => a + Number(e.amount), 0))).toBe(400);
    const inv = await until(() => prisma.invoice.findUnique({ where: { orderId: o.id } }), (i) => !!i, 'invoice');
    expect(Number(inv!.customerTotal)).toBe(590);
    const pdf = await fetch(`${base}/invoices/orders/${o.id}/pdf?docKind=ALL`, { headers: { Authorization: `Bearer ${token(cust)}` } });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).slice(0, 4).toString()).toBe('%PDF');
    ids.onlineOrder = o.id; ids.onlineCustomer = cust;
  });

  // ── 2 + 4 + 6: cart, wallet + online, two jobs, one payment, duplicate callbacks ──
  it('2/4/6. cart with two service jobs, wallet + one online payment; duplicate callbacks and webhook → one confirmation, one wallet debit; partners see nothing to collect', async () => {
    const cust = await mkUser('CUSTOMER', { walletBalance: 200 });
    const body = cartBody([{ type: 'SERVICE', serviceId: ids.svcA.id }, { type: 'SERVICE', serviceId: ids.svcB.id }], { phone: cust.phone, walletAmount: 200, paymentMethod: 'ONLINE' });
    // wallet without login → refused
    expect((await api('POST', '/master-orders/public/checkout', { body })).status).toBe(401);
    const co = await api('POST', '/master-orders/public/checkout', { as: cust, body });
    expect(co.status).toBe(201);
    // retry of the same checkout (double click / network) → same cart, not a second one
    const again = await api('POST', '/master-orders/public/checkout', { as: cust, body });
    expect(again.data.masterOrderId).toBe(co.data.masterOrderId);
    const mo = await prisma.masterOrder.findUniqueOrThrow({ where: { id: co.data.masterOrderId }, include: { childOrders: true } });
    expect(mo.childOrders).toHaveLength(2);
    expect(mo.childOrders.every((c) => c.paymentMethod === 'ONLINE')).toBe(true);
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: cust.id } })).walletBalance)).toBe(0); // wallet taken at checkout
    expect(Number(mo.totalAmount)).toBe(r2(944 - 200)); // (500+300)×1.18 − 200 wallet
    const ptx = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId: mo.id } });
    expect(ptx.masterOrderId).toBe(mo.id);

    const pay = customerPays(co.data.gatewayOrderId);
    const confirm = () => api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: mo.id, gatewayOrderId: co.data.gatewayOrderId, paymentId: pay.paymentId, signature: pay.signature } });
    const results = await Promise.all([confirm(), confirm(), confirm()]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const wh = await webhook('payment.captured', { id: pay.paymentId, order_id: co.data.gatewayOrderId, amount: Math.round(744 * 100), fee: 236, tax: 36 });
    if (wh.status >= 300) throw new Error('webhook: ' + JSON.stringify(wh.raw));
    await sleep(800);
    const paid = await prisma.masterOrder.findUniqueOrThrow({ where: { id: mo.id }, include: { childOrders: true } });
    expect(paid.paymentStatus).toBe('PAID');
    expect(paid.childOrders.every((c) => c.paymentStatus === 'PAID' && c.paymentMethod === 'ONLINE' && Number(c.cartPaidAmount) === Number(c.totalAmount))).toBe(true);
    expect(r2(paid.childOrders.reduce((a, c) => a + Number(c.cartPaidAmount), 0))).toBe(744);
    expect(await prisma.walletTransaction.count({ where: { userId: cust.id, type: 'DEBIT' } })).toBe(1);
    expect(await prisma.orderTimeline.count({ where: { orderId: paid.childOrders[0].id, status: 'CONFIRMED' } })).toBe(1);

    for (const child of paid.childOrders) {
      const partner = child.serviceId === ids.svcA.id ? ids.pA : ids.pB;
      const run = await partnerRunsJob(child.id, partner);
      expect(run.balance.balanceDue).toBe(0);
      expect(run.balance.paidAmount + run.balance.walletUsed).toBe(run.balance.totalAmount);
      expect(run.complete.status).toBe(201);
      // a partner trying to collect cash on a prepaid job records nothing
      const extra = await api('POST', `/orders/${child.id}/collect-balance`, { as: partner.user, body: { mode: 'CASH' } });
      expect(extra.data.message).toMatch(/already fully paid/);
      expect(await prisma.paymentTransaction.count({ where: { orderId: child.id } })).toBe(0);
      expect((await order(child.id)).earningsStatus).toBe('POSTED');
    }
    ids.cartMaster = mo.id;
  });

  // ── 3 + 10: direct cash, collected with the OTP-verified completion; earnings & withdrawal ──
  it('3/10. cash on service: unpaid job never withdrawable; cash collected with the customer\'s completion OTP is verified, nets the partner ledger, and releases earnings', async () => {
    const cust = await mkUser('CUSTOMER');
    const co = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'SERVICE', serviceId: ids.svcB.id }], { phone: cust.phone, paymentMethod: 'COD' }) });
    expect(co.status).toBe(201);
    const child = (await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } }));
    expect(child.paymentMethod).toBe('COD');
    const before = Number((await vendorRow(ids.pB.vendor.id)).pendingPayout);
    const run = await partnerRunsJob(child.id, ids.pB, { collection: { mode: 'CASH' } });
    expect(run.balance.balanceDue).toBe(354); // 300 + 18%
    expect(run.complete.status).toBe(201);
    const pts = await prisma.paymentTransaction.findMany({ where: { orderId: child.id } });
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual(expect.objectContaining({ status: 'PAID', gateway: 'CASH_COLLECTION', verificationMethod: 'COMPLETION_OTP' }));
    expect(Number(pts[0].amount)).toBe(354);
    const o = await order(child.id);
    expect(o.paymentStatus).toBe('PAID');
    expect(o.earningsStatus).toBe('POSTED');
    // economics: +240 earning (300 − 60 commission) − 354 cash in hand = −114 (owes commission + GST);
    // the lead cost paid at accept is part of the commission, a warranty hold only defers money
    const entries = await prisma.partnerLedgerEntry.findMany({ where: { orderId: child.id } });
    expect(r2(entries.filter((e) => !['HOLD', 'HOLD_RELEASE'].includes(e.type)).reduce((a, e) => a + Number(e.amount), 0))).toBe(-114);
    expect(entries.filter((e) => e.type === 'COD_COLLECTION').map((e) => Number(e.amount))).toEqual([-354]);
    const held = r2(entries.filter((e) => e.type === 'HOLD').reduce((a, e) => a + Number(e.amount), 0));
    expect(r2(Number((await vendorRow(ids.pB.vendor.id)).pendingPayout) - before)).toBe(r2(-114 + held));
  });

  it('10. older-app flow: completed without collection → nothing withdrawable; reported cash is pending until the customer confirms', async () => {
    const cust = await mkUser('CUSTOMER');
    const p = await mkPartner((await prisma.serviceVendor.findUniqueOrThrow({ where: { id: ids.pA.vendor.id } })).skills[0]);
    const co = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'SERVICE', serviceId: ids.svcA.id }], { phone: cust.phone, paymentMethod: 'COD' }) });
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } });
    // the other partner is busy elsewhere; this one takes it
    const run = await partnerRunsJob(child.id, p);
    expect(run.complete.status).toBe(201);
    expect((await order(child.id)).earningsStatus).toBe('DEFERRED');
    // only the lead cost taken at accept; no earning for an unpaid job
    expect(await prisma.partnerLedgerEntry.count({ where: { orderId: child.id, type: 'JOB_EARNING' } })).toBe(0);
    expect(Number((await vendorRow(p.vendor.id)).pendingPayout)).toBeLessThanOrEqual(0);
    expect((await api('POST', '/vendors/withdrawals', { as: p.user, body: { amount: 100 } })).status).toBe(400); // unearned

    await api('POST', `/orders/${child.id}/collect-balance`, { as: p.user, body: { mode: 'CASH' } });
    const pending = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId: child.id } });
    expect(pending.status).toBe('PENDING');
    expect((await order(child.id)).paymentStatus).not.toBe('PAID');
    // the partner cannot confirm their own report
    expect((await api('POST', `/orders/${child.id}/cash-collections/${pending.id}/confirm`, { as: p.user })).status).toBe(403);
    // the customer confirms
    expect((await api('POST', `/orders/${child.id}/cash-collections/${pending.id}/confirm`, { as: cust })).status).toBe(201);
    const o = await order(child.id);
    expect(o.paymentStatus).toBe('PAID');
    expect(o.earningsStatus).toBe('POSTED');
    const entries = await prisma.partnerLedgerEntry.findMany({ where: { orderId: child.id } });
    expect(r2(entries.filter((e) => !['HOLD', 'HOLD_RELEASE'].includes(e.type)).reduce((a, e) => a + Number(e.amount), 0))).toBe(r2(400 - 590)); // −190
  });

  // ── 5: failed / pending online payment; unpaid wallet returned on cancel ──
  it('5/8. pending or failed online payment is never shown as paid, never dispatched; cancelling returns the wallet portion once', async () => {
    const cust = await mkUser('CUSTOMER', { walletBalance: 100 });
    const co = await api('POST', '/master-orders/public/checkout', { as: cust, body: cartBody([{ type: 'SERVICE', serviceId: ids.svcA.id }], { phone: cust.phone, walletAmount: 100, paymentMethod: 'ONLINE' }) });
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } });
    expect(child.status).toBe('PENDING_PAYMENT');
    // payment fails at the gateway
    await webhook('payment.failed', { id: 'pay_failed_1', order_id: co.data.gatewayOrderId, amount: 49000, error_description: 'declined' });
    // a forged confirmation (wrong signature) is refused
    expect((await api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: co.data.masterOrderId, gatewayOrderId: co.data.gatewayOrderId, paymentId: 'pay_x', signature: 'forged' } })).status).toBe(400);
    await sleep(500);
    const o = await order(child.id);
    expect(o.paymentStatus).toBe('PENDING');
    expect(o.dispatchAttempts).toBe(0);
    const bal = await api('GET', `/orders/${child.id}/balance`, { as: cust });
    expect(bal.data.paidAmount).toBe(0);
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: cust.id } })).walletBalance)).toBe(0);
    expect((await api('PATCH', `/orders/${child.id}/cancel`, { as: cust, body: { reason: 'changed my mind' } })).status).toBe(200);
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: cust.id } })).walletBalance)).toBe(100);
    expect(await prisma.refundRequest.count({ where: { orderId: child.id } })).toBe(0);
    await api('PATCH', `/orders/${child.id}/cancel`, { as: cust, body: { reason: 'again' } });
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: cust.id } })).walletBalance)).toBe(100); // once
  });

  // ── 6: concurrent checkouts — unique numbers, no crash ──
  it('6. concurrent checkouts get distinct cart numbers (no collision crash)', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'SERVICE', serviceId: ids.svcB.id }], { paymentMethod: 'COD' }) })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.data.masterOrderNumber)).size).toBe(5);
  });

  // ── 8: cancellation after arrival ──
  it('8. after the partner arrives the customer cannot cancel directly (review required); before arrival a paid order raises a refund request', async () => {
    const cust = await mkUser('CUSTOMER');
    const co = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'SERVICE', serviceId: ids.svcB.id }], { phone: cust.phone, paymentMethod: 'COD' }) });
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } });
    await until(() => order(child.id), (o) => o.dispatchAttempts >= 1, 'dispatch');
    await api('POST', `/vendors/service/me/jobs/${child.id}/accept`, { as: ids.pB.user });
    await api('PATCH', `/orders/${child.id}/en-route`, { as: ids.pB.user });
    await api('PATCH', `/orders/${child.id}/arrived`, { as: ids.pB.user, body: { latitude: 23.2156, longitude: 77.4304, accuracyM: 10 } });
    const c = await api('PATCH', `/orders/${child.id}/cancel`, { as: cust, body: { reason: 'late' } });
    expect(c.status).toBe(409);
    expect((await order(child.id)).status).toBe('VENDOR_EN_ROUTE');

    const paidCust = ids.onlineCustomer;
    const o2 = await api('POST', '/orders', { as: paidCust, body: { type: 'SERVICE', serviceId: ids.svcB.id, inlineAddress: { fullAddress: '9 Hill', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462001', latitude: 23.2, longitude: 77.4 } } });
    const rzo = await api('POST', '/payments/create-order', { as: paidCust, body: { amount: 354, orderId: o2.data.id } });
    const pay = customerPays(rzo.data.id || rzo.data.gatewayOrderId);
    await api('POST', `/orders/${o2.data.id}/confirm-payment`, { as: paidCust, body: { paymentId: pay.paymentId, gatewayOrderId: rzo.data.id || rzo.data.gatewayOrderId, signature: pay.signature } });
    expect((await api('PATCH', `/orders/${o2.data.id}/cancel`, { as: paidCust, body: { reason: 'not needed' } })).status).toBe(200);
    const rr = await prisma.refundRequest.findFirstOrThrow({ where: { orderId: o2.data.id } });
    expect(rr.status).toBe('REQUESTED');
  });

  // ── 9: refund after completion → credit note ──
  it('9. refund on a completed, invoiced, paid job → wallet credit and a credit note; the invoice itself is untouched', async () => {
    const cust = ids.onlineCustomer;
    const orderId = ids.onlineOrder;
    const raised = await api('POST', '/refunds', { as: cust, body: { orderId, reason: 'fan wobbles' } });
    expect(raised.status).toBe(201);
    const decided = await api('POST', `/refunds/${raised.data.id}/decide`, { as: ids.admin, body: { decisionMode: 'WALLET_CREDIT', approvedAmount: 100, adminNotes: 'partial goodwill refund' } });
    expect(decided.status).toBeLessThan(300);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId }, include: { creditNotes: true } });
    expect(Number(inv.customerTotal)).toBe(590);
    expect(inv.creditNotes).toHaveLength(1);
    expect(Number(inv.creditNotes[0].totalReversed)).toBe(100);
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: cust.id } })).walletBalance)).toBe(100);
  });

  // ── 7: OTP limits; admin override controls ──
  it('7. wrong start OTPs are locked out after 5 attempts (even when sent in parallel); admin cannot force completion/refund states', async () => {
    const cust = await mkUser('CUSTOMER');
    const co = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'SERVICE', serviceId: ids.svcB.id }], { phone: cust.phone, paymentMethod: 'COD' }) });
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } });
    await until(() => order(child.id), (o) => o.dispatchAttempts >= 1, 'dispatch');
    await api('POST', `/vendors/service/me/jobs/${child.id}/accept`, { as: ids.pB.user });
    await api('PATCH', `/orders/${child.id}/en-route`, { as: ids.pB.user });
    const real = (await order(child.id)).startOtp!;
    const wrong = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999'].filter((x) => x !== real);
    await Promise.all(wrong.map((otp) => api('POST', `/orders/${child.id}/verify-otp`, { as: ids.pB.user, body: { otp } })));
    expect((await order(child.id)).startOtpFailedAttempts).toBe(5);
    const right = await api('POST', `/orders/${child.id}/verify-otp`, { as: ids.pB.user, body: { otp: real } });
    expect(right.status).toBe(400); // locked until a new code is sent to the customer
    expect((await order(child.id)).status).toBe('VENDOR_EN_ROUTE');

    for (const status of ['COMPLETED', 'INVOICED', 'REFUNDED', 'STARTED']) {
      const r = await api('PATCH', `/admin/orders/${child.id}/status`, { as: ids.admin, body: { status } });
      expect(r.status).toBe(400);
    }
    expect((await order(child.id)).status).toBe('VENDOR_EN_ROUTE');
    expect(await prisma.invoice.count({ where: { orderId: child.id } })).toBe(0);
  });

  // ── 11: product COD vs prepaid, through the seller workflow to the shipment ──
  it('11. product COD cart → the job is marked COD and its shipment expects cash; a prepaid product shipment expects none', async () => {
    const sellerUser = await mkUser('PRODUCT_VENDOR');
    const seller = await prisma.productVendor.create({ data: { userId: sellerUser.id, businessName: 'E2E Fittings', state: 'Madhya Pradesh' } as any });
    const pcat = await prisma.productCategory.create({ data: { key: `E2EP${Date.now().toString(36)}`, name: 'E2E Fittings' } as any });
    const product = await prisma.product.create({ data: {
      categoryId: pcat.id, vendorId: seller.id, name: 'Wall switch', slug: `e2e-sw-${Date.now().toString(36)}`, sku: `E2E-SW-${Date.now().toString(36)}`,
      price: 200, stock: 50, gstOverridePercent: 18, gstInclusive: false, isActive: true,
    } as any });

    async function sellerShips(orderId: string) {
      for (const step of ['accept', 'processing', 'ready-for-pickup']) {
        const r = await api('POST', `/vendors/product/me/orders/${orderId}/${step}`, { as: sellerUser });
        if (r.status >= 300) throw new Error(`${step}: ${JSON.stringify(r.raw)}`);
      }
      return until(() => prisma.shipment.findUnique({ where: { orderId } }), (s) => !!s, 'shipment');
    }

    // COD
    const cod = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'PRODUCT', productId: product.id, quantity: 2 }], { paymentMethod: 'COD' }) });
    expect(cod.status).toBe(201);
    const codChild = await prisma.order.findFirstOrThrow({ where: { masterOrderId: cod.data.masterOrderId } });
    expect(codChild.paymentMethod).toBe('COD');
    const codShip = await sellerShips(codChild.id);
    expect(codShip!.codSettlementStatus).toBe('COD_EXPECTED');
    expect(Number(codShip!.codAmount)).toBe(Number(codChild.totalAmount));

    // prepaid online
    const cust = await mkUser('CUSTOMER');
    const pre = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'PRODUCT', productId: product.id, quantity: 1 }], { phone: cust.phone, paymentMethod: 'ONLINE' }) });
    const pay = customerPays(pre.data.gatewayOrderId);
    expect((await api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: pre.data.masterOrderId, gatewayOrderId: pre.data.gatewayOrderId, paymentId: pay.paymentId, signature: pay.signature } })).status).toBe(201);
    const preChild = await prisma.order.findFirstOrThrow({ where: { masterOrderId: pre.data.masterOrderId } });
    expect(preChild.paymentMethod).toBe('ONLINE');
    expect(preChild.paymentStatus).toBe('PAID');
    const preShip = await sellerShips(preChild.id);
    expect(preShip!.codSettlementStatus).toBe('NOT_APPLICABLE');
    expect(preShip!.codAmount).toBeNull();
    // product invoice issued automatically at hand-over
    const inv = await until(() => prisma.invoice.findUnique({ where: { orderId: preChild.id } }), (i) => !!i, 'product invoice');
    expect(inv!.transactionType).toBe('MARKETPLACE_PRODUCT');
  });

  it('8. admin confirms partner-reported cash: written evidence required, order + partner ledger updated exactly once, audited', async () => {
    const cust = await mkUser('CUSTOMER');
    const p = await mkPartner((await prisma.serviceVendor.findUniqueOrThrow({ where: { id: ids.pB.vendor.id } })).skills[0]);
    const co = await api('POST', '/master-orders/public/checkout', { body: cartBody([{ type: 'SERVICE', serviceId: ids.svcB.id }], { phone: cust.phone, paymentMethod: 'COD' }) });
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } });
    await partnerRunsJob(child.id, p); // older-app flow: complete, then report cash
    await api('POST', `/orders/${child.id}/collect-balance`, { as: p.user, body: { mode: 'CASH' } });
    const pending = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId: child.id } });
    // the admin order detail shows it
    const detail = await api('GET', `/admin/orders/${child.id}`, { as: ids.admin });
    expect(detail.data.cashCollections.map((c: any) => c.status)).toEqual(['PENDING']);
    // no evidence → refused; a customer of another order → refused
    expect((await api('POST', `/orders/${child.id}/cash-collections/${pending.id}/confirm`, { as: ids.admin, body: {} })).status).toBe(400);
    expect((await api('POST', `/orders/${child.id}/cash-collections/${pending.id}/confirm`, { as: await mkUser('CUSTOMER') })).status).toBe(403);
    const ok = await api('POST', `/orders/${child.id}/cash-collections/${pending.id}/confirm`, { as: ids.admin, body: { evidence: 'Called customer 16 Oct, confirmed ₹354 cash paid' } });
    expect(ok.status).toBe(201);
    const again = await api('POST', `/orders/${child.id}/cash-collections/${pending.id}/confirm`, { as: ids.admin, body: { evidence: 'Repeat click on the same confirmation' } });
    expect(again.status).toBe(201);
    expect(await prisma.partnerLedgerEntry.count({ where: { orderId: child.id, type: 'COD_COLLECTION' } })).toBe(1);
    expect(await prisma.partnerLedgerEntry.count({ where: { orderId: child.id, type: 'JOB_EARNING' } })).toBe(1);
    expect((await order(child.id)).paymentStatus).toBe('PAID');
    const audit = await prisma.auditLog.findMany({ where: { action: 'CASH_COLLECTION_CONFIRMED', targetId: pending.id } });
    expect(audit).toHaveLength(1);
    expect((audit[0].metadata as any).evidence).toMatch(/Called customer/);
  });

  // ── 12: reports see cart payments without double counting ──
  it('12. accounting: invoices, ledger and reports agree; cart payments are counted once', async () => {
    const summary = await api('GET', '/admin/accounting/gst-summary', { as: ids.admin });
    expect(summary.status).toBe(200);
    expect(summary.data.note).toMatch(/NOT a filed return/);
    const xlsx = await fetch(`${base}/admin/accounting/sales-register`, { headers: { Authorization: `Bearer ${token(ids.admin)}` } });
    expect(xlsx.status).toBe(200);
    expect(Buffer.from(await xlsx.arrayBuffer()).slice(0, 2).toString()).toBe('PK');
    // every completed job here is either fully, verifiably paid with earnings POSTED, or DEFERRED
    const jobs = await prisma.order.findMany({ where: { status: { in: ['COMPLETED', 'INVOICED'] }, serviceId: { in: [ids.svcA.id, ids.svcB.id] } } });
    for (const j of jobs) {
      const earned = await prisma.partnerLedgerEntry.count({ where: { orderId: j.id, type: 'JOB_EARNING' } });
      expect(earned).toBe(j.earningsStatus === 'POSTED' ? 1 : 0);
    }
    // the cart's one online payment equals the sum of its jobs' allocated shares
    const mo = await prisma.masterOrder.findUniqueOrThrow({ where: { id: ids.cartMaster }, include: { childOrders: true } });
    const paidRow = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId: mo.id, status: 'PAID' } });
    expect(r2(mo.childOrders.reduce((a, c) => a + Number(c.cartPaidAmount), 0))).toBe(Number(paidRow.amount));
  });
});
