/* eslint-disable */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

// The connections between the two apps and the backend, end to end on a throwaway database with
// a fake payment gateway. Runs only when E2E_DATABASE_URL points at the local test cluster.
const url = process.env.E2E_DATABASE_URL || '';
const d = /localhost:55432/.test(url) ? describe : describe.skip;
jest.setTimeout(180_000);
const JWT_SECRET = 'e2e-jwt-secret';

d('app connections', () => {
  let app: any, prisma: PrismaClient, base: string;
  let customer: any, partnerU: any, vendor: any, svc: any, cat: any, orderId: string, orderNumber: string, masterNumber: string;
  let seq = 0;
  const ph = () => `+9176${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
  const tok = (u: any) => jwt.sign({ sub: u.id, phone: u.phone, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
  const mkUser = (role: string) => prisma.user.create({ data: { phone: ph(), name: `${role} ${seq}`, role, isVerified: true } as any });
  const api = async (method: string, path: string, as: any, body?: any) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${tok(as)}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let j: any = text; try { j = JSON.parse(text); } catch {}
    return { status: res.status, data: j?.data, raw: j, text };
  };
  const expectNoOtp = (text: string) => { expect(text).not.toMatch(/"(startOtp|endOtp|otp)":"/); };

  beforeAll(async () => {
    Object.assign(process.env, { DATABASE_URL: url, NODE_ENV: 'test', JWT_SECRET, JWT_REFRESH_SECRET: 'r', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'k', RAZORPAY_WEBHOOK_SECRET: 'w', FRONTEND_URL: 'http://localhost:3000' });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('./app.module');
    const { configureHttpApp } = require('./app.setup');
    app = await NestFactory.create(AppModule, { rawBody: true, bodyParser: true, logger: false });
    configureHttpApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
    const tag = crypto.randomBytes(4).toString('hex').toUpperCase();
    await prisma.city.upsert({ where: { name: 'Bhopal' }, update: { isActive: true }, create: { name: 'Bhopal', state: 'Madhya Pradesh', latitude: 23.25, longitude: 77.41, isActive: true } as any });
    cat = await prisma.serviceCategory.create({ data: { key: `CON${tag}`, name: 'Conn', icon: 'x', slug: `con-${tag.toLowerCase()}` } as any });
    svc = await prisma.service.create({ data: { categoryId: cat.id, name: 'Conn svc', slug: `con-s-${tag.toLowerCase()}`, basePrice: 500, hsnSac: '998719', isActive: true } as any });
    await prisma.commissionRule.create({ data: { ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: cat.id, commissionType: 'PERCENTAGE', value: 20, isActive: true } as any });
    customer = await mkUser('CUSTOMER');
    partnerU = await mkUser('SERVICE_VENDOR');
    vendor = await prisma.serviceVendor.create({ data: { userId: partnerU.id, fullName: 'P', businessName: 'P', baseCity: 'Bhopal', staffType: 'PARTNER', status: 'ACTIVE', isOnline: true, skills: [`CON${tag}`], serviceRadius: 25, bankAccountNumber: '99887766' } as any });
    const co = await api('POST', '/master-orders/public/checkout', customer, { name: 'C', phone: customer.phone, items: [{ type: 'SERVICE', serviceId: svc.id }], fullAddress: '12 Test Road, Arera Colony', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462016', latitude: 23.2156, longitude: 77.4304, paymentMethod: 'COD', idempotencyKey: `i${tag}` });
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId } });
    orderId = child.id; orderNumber = child.orderNumber;
    masterNumber = (await prisma.masterOrder.findUniqueOrThrow({ where: { id: co.data.masterOrderId } })).masterOrderNumber;
    for (let i = 0; i < 40; i++) { if ((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).dispatchAttempts >= 1) break; await new Promise((r) => setTimeout(r, 250)); }
    expect((await api('POST', `/vendors/service/me/jobs/${orderId}/accept`, partnerU)).status).toBeLessThan(300);
  });

  afterAll(async () => { await app?.close(); await prisma?.$disconnect(); });

  it('the partner never receives the customer codes; the customer still does', async () => {
    const enRoute = await api('PATCH', `/orders/${orderId}/en-route`, partnerU);
    expect(enRoute.status).toBeLessThan(300);
    expectNoOtp(enRoute.text);
    for (const path of ['/vendors/service/me/jobs', `/vendors/service/me/jobs/${orderId}`, `/orders/${orderId}`]) {
      const r = await api('GET', path, partnerU);
      expect(r.status).toBe(200);
      expectNoOtp(r.text);
    }
    const own = await api('GET', `/orders/${orderId}`, customer);
    expect(own.data.startOtp).toMatch(/^\d{4}$/);
  });

  it('public tracking returns no codes and no partner bank details', async () => {
    const single = await api('GET', `/orders/public/track/${orderNumber}?phone=${encodeURIComponent(customer.phone)}`, null);
    expect(single.status).toBe(200);
    expectNoOtp(single.text);
    const master = await api('GET', `/master-orders/public/track/${masterNumber}?phone=${encodeURIComponent(customer.phone)}`, null);
    expect(master.status).toBe(200);
    expectNoOtp(master.text);
    expect(master.text).not.toContain('99887766');
    expect(master.data.childOrders[0].vendor.user.name).toBeTruthy();
    const detail = await api('GET', `/master-orders/${master.data.id}`, customer);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('99887766');
  });

  it('a job goes through arrival, start, a rejected and an approved extra, and completion', async () => {
    await api('PATCH', `/orders/${orderId}/arrived`, partnerU, { latitude: 23.2156, longitude: 77.4304, accuracyM: 10 });
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect((await api('POST', `/orders/${orderId}/verify-otp`, partnerU, { otp: o.startOtp })).status).toBeLessThan(300);

    const rejected = await api('POST', `/orders/${orderId}/extra-work`, partnerU, { description: 'wire', amount: 50 });
    expect(rejected.status).toBeLessThan(300);
    const before = Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).totalAmount);
    expect((await api('PATCH', `/orders/extra-work/${rejected.data.id}/reject`, partnerU, {})).status).toBe(403);
    const rej = await api('PATCH', `/orders/extra-work/${rejected.data.id}/reject`, customer, { reason: 'not needed' });
    expect(rej.status).toBe(200);
    expect(rej.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'not needed', customerApproved: false });
    expect((await api('PATCH', `/orders/extra-work/${rejected.data.id}/approve`, customer)).status).toBe(409);
    expect((await api('PATCH', `/orders/extra-work/${rejected.data.id}/reject`, customer, {})).status).toBe(409);
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).totalAmount)).toBe(before);
    // A rejected item can't be approved later through the technician's OTP path either.
    expect((await api('POST', `/orders/${orderId}/extra-work/otp`, partnerU)).status).toBe(404);

    const approved = await api('POST', `/orders/${orderId}/extra-work`, partnerU, { description: 'switch', amount: 100 });
    const ok = await api('PATCH', `/orders/extra-work/${approved.data.id}/approve`, customer);
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ status: 'APPROVED', customerApproved: true });
    expect((await api('PATCH', `/orders/extra-work/${approved.data.id}/approve`, customer)).status).toBe(409);
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).totalAmount)).toBeGreaterThan(before);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const done = await api('POST', `/orders/${orderId}/complete`, partnerU, { otp: after.endOtp, paymentMode: 'CASH', cashCollected: Number(after.totalAmount) });
    expect([200, 201]).toContain(done.status);
    expectNoOtp(done.text);
  });

  it('a profile update cannot change role, wallet or verification', async () => {
    const r = await api('PATCH', '/users/me', customer, { name: 'New Name', role: 'SUPER_ADMIN', walletBalance: 99999, isBlocked: false });
    expect(r.status).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(u.name).toBe('New Name');
    expect(u.role).toBe('CUSTOMER');
    expect(Number(u.walletBalance)).toBe(0);
  });

  it('the partner app routes that used to 404 now answer', async () => {
    const wallet = await api('GET', '/vendors/wallet/available', partnerU);
    expect(wallet.status).toBe(200);
    expect(wallet.data).toMatchObject({ canWithdraw: true, available: expect.any(Number), ledgerBalance: expect.any(Number), heldAmount: expect.any(Number), pendingWithdrawals: expect.any(Number) });
    expect((await api('GET', '/vendors/wallet/available', customer)).status).toBe(403);
    const upcoming = await api('GET', '/vendors/service/me/upcoming-scheduled-jobs', partnerU);
    expect(upcoming.status).toBe(200);
    expect(upcoming.data).toEqual([]);
    expect((await api('GET', '/location/ifsc/not-valid', null)).status).toBe(400);
  });

  it('OTP limits count per phone, so one shared IP does not lock everyone out', async () => {
    const samePhone = ph();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await api('POST', '/auth/send-otp', null, { phone: samePhone })).status);
    expect(statuses[5]).toBe(429);
    const others: number[] = [];
    for (let i = 0; i < 8; i++) others.push((await api('POST', '/auth/send-otp', null, { phone: ph() })).status);
    expect(others.every((s) => s < 300)).toBe(true);
  });

  // HELD: the production DEV_OTP_OVERRIDE refusal is an OTP change and OTP/MSG91 is out of scope
  // this phase (production logins may depend on it until MSG91 is verified). Re-enable with it.
  it.skip('the fixed test code does not sign in on production unless deliberately allowed', async () => {
    const phone = ph();
    Object.assign(process.env, { DEV_OTP_OVERRIDE: '424242', NODE_ENV: 'production' });
    try {
      expect((await api('POST', '/auth/send-otp', null, { phone })).status).toBeLessThan(300);
      expect((await api('POST', '/auth/verify-otp', null, { phone, otp: '424242' })).status).toBe(401);
      process.env.ALLOW_DEV_OTP_IN_PRODUCTION = 'true';
      expect((await api('POST', '/auth/verify-otp', null, { phone, otp: '424242' })).status).toBeLessThan(300);
    } finally {
      process.env.NODE_ENV = 'test';
      delete process.env.DEV_OTP_OVERRIDE;
      delete process.env.ALLOW_DEV_OTP_IN_PRODUCTION;
    }
  });

  it('dispatch retries stop at the cap and for slots long past', async () => {
    const { DispatchRetryService } = require('./modules/orders/orders.module');
    const sweep = app.get(DispatchRetryService);
    const mk = async (data: any) => {
      const tag = crypto.randomBytes(5).toString('hex');
      const { addressId } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      return prisma.order.create({ data: { orderNumber: `RT${tag}`, customerId: customer.id, serviceId: svc.id, type: 'SERVICE', status: 'CONFIRMED', addressId, totalAmount: 100, serviceAmount: 100, lastDispatchedAt: new Date(Date.now() - 2 * 3600_000), ...data } as any });
    };
    const capped = await mk({ dispatchAttempts: 24 });
    const past = await mk({ dispatchAttempts: 1, slotStart: new Date(Date.now() - 3 * 86400_000) });
    const live = await mk({ dispatchAttempts: 1, slotStart: new Date(Date.now() + 86400_000) });
    await sweep.sweep();
    const get = (o: any) => prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect((await get(capped)).dispatchAttempts).toBe(24);
    expect((await get(past)).dispatchAttempts).toBe(1);
    expect((await get(live)).dispatchAttempts).toBeGreaterThan(1);
  });

  it('a malformed body is a 400 and internals never reach the client', async () => {
    const r = await api('PATCH', '/users/me/addresses/does-not-exist', customer, { label: { bad: true } });
    expect(r.text).not.toMatch(/node_modules|prisma\.|Invalid `/);
    const { HttpExceptionFilter } = require('./common');
    const { Prisma } = require('@prisma/client');
    const out: any = {};
    const host: any = { switchToHttp: () => ({ getResponse: () => ({ status: (s: number) => { out.status = s; return { json: (b: any) => { out.body = b; } }; } }), getRequest: () => ({ url: '/x', method: 'POST' }) }) };
    const filter = new HttpExceptionFilter();
    (filter as any).logger = { warn() {}, error() {} };
    filter.catch(new Prisma.PrismaClientValidationError('Invalid `prisma.x()` C:\\app\\y.ts', { clientVersion: '5' }), host);
    expect(out.status).toBe(400);
    expect(out.body.message).toBe('Invalid request');
    filter.catch(new Error('secret path C:\\app'), host);
    expect(out.status).toBe(500);
    expect(out.body.message).toBe('Internal server error');
  });
});
