import { releaseProductStock } from '../../common';
import { StockHoldExpiryService, STOCK_HOLD_EXPIRED_REASON } from './stock-hold-expiry.service';

/**
 * Product stock is reserved (decremented) at checkout. Before this, no path ever gave it back:
 * cancelled, seller-rejected and never-paid orders kept their units forever.
 */
function makeDb(seed: { products?: any[]; orders?: any[]; items?: any[]; masters?: any[]; txs?: any[]; settings?: any[] }) {
  const db = {
    products: seed.products || [], orders: seed.orders || [], items: seed.items || [],
    masters: seed.masters || [], txs: seed.txs || [], refunds: [] as any[], settings: seed.settings || [], timeline: [] as any[],
  };
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v && v.not === null && row[k] == null) return false;
      if ('lt' in v && !(row[k] != null && row[k] < v.lt)) return false;
      if ('in' in v && !v.in.includes(row[k])) return false;
      if ('notIn' in v && v.notIn.includes(row[k])) return false;
      return true;
    }
    return v === null ? row[k] == null : row[k] === v;
  });
  const model = (rows: any[]) => ({
    findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    findFirst: jest.fn(async ({ where }: any = {}) => rows.find((r) => matches(r, where)) ?? null),
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    updateMany: jest.fn(async ({ where, data }: any) => { const hit = rows.filter((r) => matches(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = rows.find((x) => matches(x, where));
      for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as any) ? r[k] + (v as any).increment : v;
      return { ...r };
    }),
    create: jest.fn(async ({ data }: any) => { const r = { id: `id${rows.length + 1}`, ...data }; rows.push(r); return r; }),
  });
  const prisma: any = {
    product: model(db.products), order: model(db.orders), orderItem: model(db.items), masterOrder: model(db.masters),
    paymentTransaction: model(db.txs), refundRequest: model(db.refunds), siteSetting: model(db.settings),
    walletTransaction: { findFirst: jest.fn(async () => null) }, orderTimeline: model(db.timeline),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { db, prisma };
}

const reserved = new Date('2026-11-05T08:00:00Z');
const now = new Date('2026-11-05T11:00:00Z'); // 3 h later — past the default 120-minute hold

describe('releaseProductStock', () => {
  const seed = () => makeDb({
    products: [{ id: 'p1', stock: 3 }, { id: 'p2', stock: 0 }],
    orders: [{ id: 'o1', stockReservedAt: reserved, stockReleasedAt: null }, { id: 'old', stockReservedAt: null, stockReleasedAt: null }],
    items: [{ orderId: 'o1', productId: 'p1', quantity: 2 }, { orderId: 'o1', productId: 'p2', quantity: 1 }, { orderId: 'old', productId: 'p1', quantity: 5 }],
  });

  it('gives every reserved unit back once', async () => {
    const { db, prisma } = seed();
    expect(await releaseProductStock(prisma, 'o1')).toBe(3);
    expect(db.products).toEqual([{ id: 'p1', stock: 5 }, { id: 'p2', stock: 1 }]);
    expect(await releaseProductStock(prisma, 'o1')).toBe(0); // double cancel / reject + cancel
    expect(db.products[0].stock).toBe(5);
  });

  it('never touches an order that did not reserve stock (placed before reservation existed)', async () => {
    const { db, prisma } = seed();
    expect(await releaseProductStock(prisma, 'old')).toBe(0);
    expect(db.products[0].stock).toBe(3);
  });
});

describe('StockHoldExpiryService', () => {
  const unpaidCart = (over: any = {}) => makeDb({
    products: [{ id: 'p1', stock: 1 }],
    masters: [{ id: 'm1', status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', customerId: 'c1', masterOrderNumber: 'RM-1' }],
    orders: [
      { id: 'o1', masterOrderId: 'm1', orderNumber: 'REM-1', status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', customerId: 'c1', walletUsed: 0, stockReservedAt: reserved, stockReleasedAt: null },
      { id: 'o2', masterOrderId: 'm1', orderNumber: 'REM-2', status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', customerId: 'c1', walletUsed: 0, stockReservedAt: null, stockReleasedAt: null },
    ],
    items: [{ orderId: 'o1', productId: 'p1', quantity: 2 }],
    txs: [{ orderId: 'm1', status: 'PENDING', gateway: 'RAZORPAY', gatewayOrderId: 'order_A' }],
    ...over,
  });
  const svc = (prisma: any, inProgress = false) => {
    const payments: any = { razorpayPaymentMayBeInProgress: jest.fn(async () => inProgress) };
    return { s: new StockHoldExpiryService(prisma, payments), payments };
  };

  it('cancels an unpaid cart after the hold window, returns its stock, and cancels the whole cart', async () => {
    const { db, prisma } = unpaidCart();
    const { s, payments } = svc(prisma);
    expect(await s.sweep(now)).toEqual({ expired: 1, skipped: 0 });
    expect(payments.razorpayPaymentMayBeInProgress).toHaveBeenCalledWith('order_A');
    expect(db.masters[0].status).toBe('CANCELLED');
    expect(db.orders.map((o) => [o.status, o.cancelReason])).toEqual([['CANCELLED', STOCK_HOLD_EXPIRED_REASON], ['CANCELLED', STOCK_HOLD_EXPIRED_REASON]]);
    expect(db.products[0].stock).toBe(3);
  });

  it('leaves the cart alone while Razorpay shows a payment that may still succeed', async () => {
    const { db, prisma } = unpaidCart();
    expect(await svc(prisma, true).s.sweep(now)).toEqual({ expired: 0, skipped: 1 });
    expect(db.masters[0].status).toBe('PENDING_PAYMENT');
    expect(db.products[0].stock).toBe(1);
  });

  it('never expires inside the hold window, or when the hold is set to 0', async () => {
    const early = unpaidCart();
    expect(await svc(early.prisma).s.sweep(new Date('2026-11-05T09:00:00Z'))).toEqual({ expired: 0, skipped: 0 });
    const off = unpaidCart({ settings: [{ key: 'product_stock_hold_minutes', value: '0' }] });
    expect(await svc(off.prisma).s.sweep(now)).toEqual({ expired: 0, skipped: 0 });
    expect(off.db.products[0].stock).toBe(1);
  });

  it('skips a cart that already has a PAID transaction, or a non-Razorpay pending one', async () => {
    const paid = unpaidCart({ txs: [{ orderId: 'm1', status: 'PAID', gateway: 'RAZORPAY', gatewayOrderId: 'order_A' }] });
    expect(await svc(paid.prisma).s.sweep(now)).toEqual({ expired: 0, skipped: 1 });
    const phonepe = unpaidCart({ txs: [{ orderId: 'm1', status: 'PENDING', gateway: 'PHONEPE', gatewayOrderId: 'TX1' }] });
    expect(await svc(phonepe.prisma).s.sweep(now)).toEqual({ expired: 0, skipped: 1 });
    expect(phonepe.db.products[0].stock).toBe(1);
  });

  it('a payment captured after the cancel becomes a refund request (once) — never kept silently', async () => {
    const { db, prisma } = unpaidCart();
    const { s } = svc(prisma);
    await s.sweep(now);
    await s.onCapturedAfterCancel({ orderId: 'm1' });
    await s.onCapturedAfterCancel({ orderId: 'm1' });
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({ masterOrderId: 'm1', customerId: 'c1', status: 'REQUESTED' });
  });

  it('a capture on a live (not cancelled) order, or on a paid-then-cancelled order, creates nothing', async () => {
    const live = unpaidCart();
    await svc(live.prisma).s.onCapturedAfterCancel({ orderId: 'm1' });
    expect(live.db.refunds).toHaveLength(0);
    const paidThenCancelled = unpaidCart({ masters: [{ id: 'm1', status: 'CANCELLED', paymentStatus: 'PAID', customerId: 'c1', masterOrderNumber: 'RM-1' }] });
    await svc(paidThenCancelled.prisma).s.onCapturedAfterCancel({ orderId: 'm1' });
    expect(paidThenCancelled.db.refunds).toHaveLength(0);
  });
});
