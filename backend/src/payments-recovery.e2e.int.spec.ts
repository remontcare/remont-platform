/* eslint-disable @typescript-eslint/no-var-requires */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

/**
 * PAYMENT-SYNC HARDENING end to end — the REM-1794750210856-581064 incident replayed on the real
 * application over HTTP: an online cart whose PaymentTransaction row was lost is paid on Razorpay.
 * The signed webhook (or the signed browser callback) must rebuild the row from the Razorpay
 * order's own notes and confirm the cart exactly once — but only after the captured amount is
 * re-read from the gateway and covers the total. Fake gateway; throwaway DB only.
 *
 * Runs only with E2E_DATABASE_URL pointing at the local throwaway cluster (localhost:55432).
 */
const url = process.env.E2E_DATABASE_URL || '';
const d = /localhost:55432/.test(url) ? describe : describe.skip;
jest.setTimeout(240_000);

const JWT_SECRET = 'e2e-jwt-secret';
const KEY_SECRET = 'e2e-razorpay-key-secret';
const WEBHOOK_SECRET = 'e2e-razorpay-webhook-secret';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('PAYMENT SYNC RECOVERY — full application over HTTP (throwaway DB, fake gateway)', () => {
  let app: any;
  let base = '';
  let prisma: PrismaClient;
  const rz = { orders: new Map<string, any>(), payments: new Map<string, any>() };
  const ids: Record<string, any> = {};
  let seq = 0;
  const tag = Date.now().toString(36).toUpperCase();
  const phone = () => `+9155${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
  const token = (u: any) => jwt.sign({ sub: u.id, phone: u.phone, role: u.role }, JWT_SECRET, { expiresIn: '1h' });

  async function api(method: string, path: string, opts: { as?: any; body?: any; headers?: Record<string, string>; rawBody?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (opts.as) headers.Authorization = `Bearer ${token(opts.as)}`;
    const res = await fetch(base + path, { method, headers, body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, data: json && typeof json === 'object' && 'data' in json ? json.data : json, raw: json };
  }
  function capture(gatewayOrderId: string, amountPaise?: number) {
    const pid = `pay_${crypto.randomBytes(6).toString('hex')}`;
    const o = rz.orders.get(gatewayOrderId);
    const p = { id: pid, order_id: gatewayOrderId, status: 'captured', amount: amountPaise ?? o.amount, fee: 236, tax: 36 };
    rz.payments.set(pid, p);
    return { payment: p, signature: crypto.createHmac('sha256', KEY_SECRET).update(`${gatewayOrderId}|${pid}`).digest('hex') };
  }
  function webhook(entity: any, eventId = `evt_${crypto.randomBytes(5).toString('hex')}`, sig?: string) {
    const rawBody = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity } } });
    const signature = sig ?? crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    return api('POST', '/payments/webhook', { rawBody, headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId } });
  }
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    let v = await fn();
    while (!ok(v) && Date.now() < end) { await sleep(200); v = await fn(); }
    return v;
  }
  /** An online cart whose PaymentTransaction is then deleted — the lost-row incident. */
  async function cartWithLostTransaction() {
    const cust = await prisma.user.create({ data: { phone: phone(), name: `Pay ${seq}`, role: 'CUSTOMER', isVerified: true } as any });
    const co = await api('POST', '/master-orders/public/checkout', { as: cust, body: {
      name: 'Pay Test', phone: cust.phone, items: [{ type: 'SERVICE', serviceId: ids.svc.id, quantity: 1 }],
      fullAddress: '12 Test Road', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462016', latitude: 23.2156, longitude: 77.4304,
      paymentMethod: 'ONLINE', idempotencyKey: `idem-${crypto.randomBytes(6).toString('hex')}`,
    } });
    expect(co.status).toBe(201);
    const moId = co.data.masterOrderId;
    const gatewayOrderId = co.data.gatewayOrderId;
    expect(gatewayOrderId).toBeTruthy();
    const deleted = await prisma.paymentTransaction.deleteMany({ where: { gatewayOrderId } });
    expect(deleted.count).toBe(1);
    return { cust, moId, gatewayOrderId, total: Number((await prisma.masterOrder.findUniqueOrThrow({ where: { id: moId } })).totalAmount) };
  }
  const mo = (id: string) => prisma.masterOrder.findUniqueOrThrow({ where: { id }, include: { childOrders: true } });

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url, NODE_ENV: 'test', JWT_SECRET, JWT_REFRESH_SECRET: 'e2e-refresh',
      RAZORPAY_KEY_ID: 'rzp_test_e2e', RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, FRONTEND_URL: 'http://localhost:3000',
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('./app.module');
    const { configureHttpApp } = require('./app.setup');
    app = await NestFactory.create(AppModule, { rawBody: true, bodyParser: true, logger: ['error'] });
    configureHttpApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;

    const { PaymentsService } = require('./modules/payments/payments.module');
    const payments = app.get(PaymentsService);
    payments.razorpay = {
      orders: {
        create: async (o: any) => { const id = `order_${crypto.randomBytes(6).toString('hex')}`; rz.orders.set(id, { ...o, id }); return { id, amount: o.amount, currency: 'INR' }; },
        fetch: async (id: string) => { const o = rz.orders.get(id); if (!o) throw new Error('not found'); return o; },
        fetchPayments: async (id: string) => ({ items: [...rz.payments.values()].filter((p) => p.order_id === id) }),
      },
      payments: { fetch: async (pid: string) => { const p = rz.payments.get(pid); if (!p) throw new Error('not found'); return p; } },
    };
    payments.razorpayKeyId = 'rzp_test_e2e';
    payments.razorpayKeySecret = KEY_SECRET;
    payments.razorpayWebhookSecret = WEBHOOK_SECRET;
    payments.activeGateway = 'RAZORPAY';

    await prisma.city.upsert({ where: { name: 'Bhopal' }, update: { isActive: true }, create: { name: 'Bhopal', state: 'Madhya Pradesh', latitude: 23.2599, longitude: 77.4126, isActive: true } as any });
    ids.admin = await prisma.user.create({ data: { phone: phone(), name: 'Admin', role: 'SUPER_ADMIN', isVerified: true } as any });
    ids.cat = await prisma.serviceCategory.create({ data: { key: `PAY${tag}`, name: 'Pay E2E', icon: 'x' } as any });
    ids.svc = await prisma.service.create({ data: { categoryId: ids.cat.id, name: `Pest ${tag} (2BHK)`, slug: `pay-${tag.toLowerCase()}`, basePrice: 999, hsnSac: '998719', isActive: true } as any });
    await prisma.commissionRule.create({ data: { ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: ids.cat.id, commissionType: 'PERCENTAGE', value: 20, isActive: true } as any });
    await prisma.taxConfig.create({ data: { name: `PAY SERVICE 18% ${tag}`, rate: 18, hsnCode: '998719', appliesTo: ['SERVICE'], approvalStatus: 'APPROVED', approvedBy: ids.admin.id, approvedAt: new Date(), approvalNote: 'e2e' } as any });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('the incident: lost transaction + signed webhook → row rebuilt, cart confirmed once, amount verified', async () => {
    const c = await cartWithLostTransaction();
    const { payment } = capture(c.gatewayOrderId);
    const eventId = `evt_${crypto.randomBytes(5).toString('hex')}`;
    const r = await webhook(payment, eventId);
    expect(r.status).toBeLessThan(300);
    const after = await until(() => mo(c.moId), (m) => m.paymentStatus === 'PAID');
    expect(after.status).toBe('CONFIRMED');
    expect(after.childOrders.every((o) => o.paymentStatus === 'PAID' && o.status === 'CONFIRMED')).toBe(true);
    const txs = await prisma.paymentTransaction.findMany({ where: { gatewayOrderId: c.gatewayOrderId } });
    expect(txs).toHaveLength(1);
    expect(txs[0]).toEqual(expect.objectContaining({ status: 'PAID', gatewayPaymentId: payment.id, orderId: c.moId, userId: c.cust.id }));
    expect(Number(txs[0].amount)).toBe(c.total);
    expect((await prisma.paymentWebhookEvent.findUnique({ where: { eventId } }))?.processedAt).toBeTruthy();
  });

  it('duplicate / concurrent deliveries of the same capture confirm exactly once', async () => {
    const c = await cartWithLostTransaction();
    const { payment } = capture(c.gatewayOrderId);
    await Promise.all([webhook(payment), webhook(payment), webhook(payment)]);
    await until(() => mo(c.moId), (m) => m.paymentStatus === 'PAID');
    await sleep(500);
    expect(await prisma.paymentTransaction.count({ where: { gatewayOrderId: c.gatewayOrderId, status: 'PAID' } })).toBeGreaterThanOrEqual(1);
    const timeline = await prisma.orderTimeline.findMany({ where: { orderId: { in: (await mo(c.moId)).childOrders.map((o) => o.id) }, status: 'CONFIRMED' } });
    expect(timeline.length).toBe((await mo(c.moId)).childOrders.length); // one CONFIRMED entry per child, no repeats
  });

  it('an underpaid capture is never confirmed, even with the row recovered', async () => {
    const c = await cartWithLostTransaction();
    const { payment, signature } = capture(c.gatewayOrderId, 100); // ₹1 against the real total
    await webhook(payment);
    await sleep(1500);
    expect((await mo(c.moId)).paymentStatus).not.toBe('PAID');
    const cb = await api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: c.moId, gatewayOrderId: c.gatewayOrderId, paymentId: payment.id, signature } });
    expect(cb.status).toBe(400);
    const m = await mo(c.moId);
    expect(m.paymentStatus).not.toBe('PAID');
    expect(m.status).toBe('PENDING_PAYMENT');
  });

  it('the signed browser callback alone also recovers and confirms', async () => {
    const c = await cartWithLostTransaction();
    const { payment, signature } = capture(c.gatewayOrderId);
    const cb = await api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: c.moId, gatewayOrderId: c.gatewayOrderId, paymentId: payment.id, signature } });
    expect(cb.status).toBeLessThan(300);
    const m = await mo(c.moId);
    expect(m.paymentStatus).toBe('PAID');
    expect(m.status).toBe('CONFIRMED');
  });

  it('a forged webhook or callback signature changes nothing', async () => {
    const c = await cartWithLostTransaction();
    const { payment } = capture(c.gatewayOrderId);
    expect((await webhook(payment, undefined, 'f'.repeat(64))).status).toBe(400);
    const cb = await api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: c.moId, gatewayOrderId: c.gatewayOrderId, paymentId: payment.id, signature: '0'.repeat(64) } });
    expect(cb.status).toBe(400);
    expect(await prisma.paymentTransaction.count({ where: { gatewayOrderId: c.gatewayOrderId } })).toBe(0);
    expect((await mo(c.moId)).paymentStatus).not.toBe('PAID');
  });

  it('a callback cannot attach another cart\'s payment to this cart', async () => {
    const a = await cartWithLostTransaction();
    const b = await cartWithLostTransaction();
    const { payment, signature } = capture(a.gatewayOrderId);
    const cb = await api('POST', '/master-orders/public/confirm-payment', { body: { dbOrderId: b.moId, gatewayOrderId: a.gatewayOrderId, paymentId: payment.id, signature } });
    expect(cb.status).toBe(400);
    expect((await mo(b.moId)).paymentStatus).not.toBe('PAID');
    expect(await prisma.paymentTransaction.count({ where: { gatewayOrderId: a.gatewayOrderId } })).toBe(0);
  });
});
