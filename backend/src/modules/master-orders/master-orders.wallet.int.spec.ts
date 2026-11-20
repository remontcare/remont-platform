import { PrismaClient } from '@prisma/client';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { MasterOrdersService } from './master-orders.module';

/**
 * REAL-DATABASE wallet ownership + once-only debit checks — the real MasterOrdersService and real
 * pricing against a THROWAWAY database (INTEGRATION_DATABASE_URL; skipped otherwise). Only the
 * payment gateway, routing and notifications are stubbed: no network, no money.
 * NEVER point this at production: it creates rows.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const d = url ? describe : describe.skip;

d('Cart checkout wallet ownership & once-only debit (throwaway Postgres)', () => {
  let prisma: PrismaClient;
  let svc: MasterOrdersService;
  let serviceId: string;
  let seq = 0;
  const phone = () => `+9177${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    const cat = await prisma.serviceCategory.create({ data: { key: `WAL-${Date.now()}`, name: 'Wallet test', icon: 'x', slug: `wal-${Date.now()}` } as any });
    serviceId = (await prisma.service.create({ data: { categoryId: cat.id, name: 'Tap repair', slug: `tap-${Date.now()}`, basePrice: 500, hsnSac: '998719' } as any })).id;
    const stub: any = {};
    const payments: any = {
      initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'order_int', keyId: 'rzp_test', txId: 'tx' })),
      getVerifiedCapturedAmount: jest.fn(async () => 1_000_000),
    };
    const cities: any = { getByName: async () => null, getServicePrice: async () => null };
    const memberships: any = { getActiveDiscount: async () => 0 };
    const routing: any = { route: jest.fn(async () => {}) };
    const notify: any = new Proxy({}, { get: () => async () => {} });
    svc = new MasterOrdersService(prisma as any, stub, memberships, cities, payments, stub, routing, notify, stub, stub);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  async function customer(balance: number) {
    return prisma.user.create({ data: { phone: phone(), name: 'Cust', role: 'CUSTOMER', isVerified: true, walletBalance: balance } as any });
  }
  const cart = (over: any = {}) => ({
    items: [{ type: 'SERVICE', serviceId, quantity: 1 }],
    inlineAddress: { fullAddress: '1 Test Street', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462001' },
    ...over,
  }) as any;
  const balance = async (id: string) => Number((await prisma.user.findUnique({ where: { id } }))!.walletBalance);
  const walletDebits = (userId: string) => prisma.walletTransaction.count({ where: { userId, type: 'DEBIT' } });
  const masters = (customerId: string) => prisma.masterOrder.count({ where: { customerId } });

  it('1/6. unauthenticated (guest) checkout using a victim\'s phone cannot touch the victim\'s wallet — COD and ONLINE', async () => {
    const victim = await customer(1000);
    for (const paymentMethod of ['COD', 'ONLINE'] as const) {
      await expect(svc.checkout(cart({ walletAmount: 300 }), { guestName: 'Attacker', guestPhone: victim.phone, paymentMethod }))
        .rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(await balance(victim.id)).toBe(1000);
    expect(await walletDebits(victim.id)).toBe(0);
    expect(await masters(victim.id)).toBe(0); // no order was attached to the victim either
  });

  it('2/3. customer A (authenticated) sending B\'s phone pays from A\'s wallet only; B is untouched; the order is A\'s', async () => {
    const a = await customer(1000);
    const b = await customer(1000);
    const r: any = await svc.checkout(cart({ walletAmount: 200 }), { customerId: a.id, guestPhone: b.phone, guestName: 'B', paymentMethod: 'COD' } as any);
    const mo = await prisma.masterOrder.findUnique({ where: { id: r.masterOrderId } });
    expect(mo!.customerId).toBe(a.id);
    expect(await balance(a.id)).toBe(800);
    expect(await balance(b.id)).toBe(1000);
    expect(await walletDebits(b.id)).toBe(0);
    const tx = await prisma.walletTransaction.findMany({ where: { userId: a.id } });
    expect(tx).toHaveLength(1);
    expect(Number(tx[0].amount)).toBe(200);
    expect(Number(tx[0].balanceAfter)).toBe(800);
    expect(tx[0].orderId).toBe(mo!.id);
  });

  it('5/7. legitimate ONLINE wallet payment: wallet taken once at checkout (reserved); concurrent confirmations never take it again', async () => {
    const a = await customer(1000);
    const r: any = await svc.checkout(cart({ walletAmount: 150 }), { customerId: a.id, paymentMethod: 'ONLINE' });
    expect(await balance(a.id)).toBe(850); // taken at checkout, atomically with the order
    expect(await walletDebits(a.id)).toBe(1);
    await prisma.paymentTransaction.create({ data: { orderId: r.masterOrderId, userId: a.id, amount: r.totalAmount, status: 'PAID', gateway: 'RAZORPAY', gatewayOrderId: 'order_int', gatewayPaymentId: 'pay_int_1' } as any });
    const results = await Promise.allSettled([
      svc.confirmPayment(r.masterOrderId, 'pay_int_1'),
      svc.confirmPayment(r.masterOrderId, 'pay_int_1'),
      svc.confirmPayment(r.masterOrderId, 'pay_int_1'),
    ]);
    expect(results.every((x) => x.status === 'fulfilled' || /current state/.test(String((x as any).reason?.message)))).toBe(true);
    expect(await balance(a.id)).toBe(850);
    expect(await walletDebits(a.id)).toBe(1);
    expect((await prisma.masterOrder.findUnique({ where: { id: r.masterOrderId } }))!.paymentStatus).toBe('PAID');
    await svc.confirmPayment(r.masterOrderId, 'pay_int_1'); // a later retry: idempotent no-op
    expect(await walletDebits(a.id)).toBe(1);
  });

  it('7. concurrent COD checkouts each spending the whole balance: exactly one succeeds, the wallet never goes negative', async () => {
    const a = await customer(400);
    const results = await Promise.allSettled([1, 2, 3].map(() => svc.checkout(cart({ walletAmount: 400 }), { customerId: a.id, paymentMethod: 'COD' })));
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(a.id)).toBe(0);
    expect(await walletDebits(a.id)).toBe(1);
    expect(await masters(a.id)).toBe(1); // the losers' orders rolled back with their failed debit
  });

  it('7. the wallet debit itself is atomic: concurrent debits of the whole balance — one succeeds, never negative', async () => {
    const a = await customer(400);
    const mo: any = await svc.checkout(cart(), { customerId: a.id, paymentMethod: 'COD' }); // an order to reference
    const debit = () => prisma.$transaction((tx) => (svc as any).debitWalletForOrder(tx, a.id, 400, mo.masterOrderId, mo.masterOrderNumber));
    const results = await Promise.allSettled([debit(), debit(), debit(), debit()]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(a.id)).toBe(0);
    expect(await walletDebits(a.id)).toBe(1);
  });

  it('7. a retried checkout with the same idempotency key creates one order and debits once', async () => {
    const a = await customer(1000);
    const key = `idem-${Date.now()}`;
    await svc.checkout(cart({ walletAmount: 100, idempotencyKey: key }), { customerId: a.id, paymentMethod: 'COD' });
    await svc.checkout(cart({ walletAmount: 100, idempotencyKey: key }), { customerId: a.id, paymentMethod: 'COD' });
    expect(await masters(a.id)).toBe(1);
    expect(await walletDebits(a.id)).toBe(1);
    expect(await balance(a.id)).toBe(900);
  });

  it('6. insufficient balance: rejected and nothing is created', async () => {
    const a = await customer(50);
    await expect(svc.checkout(cart({ walletAmount: 300 }), { customerId: a.id, paymentMethod: 'COD' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await balance(a.id)).toBe(50);
    expect(await masters(a.id)).toBe(0);
    expect(await walletDebits(a.id)).toBe(0);
  });
});
