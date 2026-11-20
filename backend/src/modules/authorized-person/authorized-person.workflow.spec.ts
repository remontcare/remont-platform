import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthorizedPersonService, normalizeIndianMobile } from './authorized-person.module';
import { ExtraWorkService } from '../orders/orders.module';

/**
 * Authorized Person + extra-work approval, end to end on an in-memory store, using the real
 * AuthorizedPersonService and ExtraWorkService together.
 *
 * Scenario: customer Pramod books Fan Installation (₹500) and nominates Priya (wife). The
 * electrician adds Switch Board Installation (₹300). Pramod OR Priya may decide; the first
 * decision wins; only APPROVED work is billed.
 */
type Row = Record<string, any>;

const PRAMOD = { sub: 'u-pramod', phone: '+919811111111', role: 'CUSTOMER' } as any;
const PRIYA = { sub: 'u-priya', phone: '+919822222222', role: 'CUSTOMER' } as any;
const STRANGER = { sub: 'u-x', phone: '+919833333333', role: 'CUSTOMER' } as any;
const PARTNER = { sub: 'u-partner', phone: '+919844444444', role: 'SERVICE_VENDOR' } as any;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
      if ('has' in v) return (row[k] || []).includes(v.has);
      if ('gt' in v) return row[k] != null && row[k] > v.gt;
    }
    return row[k] === v;
  });
}
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).filter((k) => k in row).map((k) => [k, row[k]])) : { ...row });

function makeWorld() {
  const now = Date.now();
  const db = {
    orders: [
      {
        id: 'o1', orderNumber: 'RI-1001', customerId: 'u-pramod', vendorId: 'sv-1', serviceId: 'svc-fan', masterOrderId: 'mo-1',
        status: 'VENDOR_ASSIGNED', slotStart: new Date(now + 3600_000), guestPhone: null,
        serviceAmount: 500, productsAmount: 0, couponDiscount: 0, membershipDiscount: 0, walletUsed: 0,
        remontCommission: 100, extraWorkAmount: 0, subtotal: 500, totalAmount: 590,
      },
      {
        id: 'o2', orderNumber: 'RI-1002', customerId: 'u-other', vendorId: 'sv-1', serviceId: 'svc-ac', masterOrderId: null,
        status: 'STARTED', slotStart: null, guestPhone: null,
        serviceAmount: 800, productsAmount: 0, couponDiscount: 0, membershipDiscount: 0, walletUsed: 0,
        remontCommission: 100, extraWorkAmount: 0, subtotal: 800, totalAmount: 944,
      },
    ] as Row[],
    users: [
      { id: 'u-pramod', phone: '+919811111111' }, { id: 'u-priya', phone: '+919822222222' },
      { id: 'u-other', phone: '+919855555555' }, { id: 'u-partner', phone: '+919844444444' },
    ] as Row[],
    vendors: [{ id: 'sv-1', userId: 'u-partner' }],
    auths: [] as Row[],
    items: [] as Row[],
  };
  let seq = 0;
  const orderView = (o: Row) => ({
    ...o,
    customer: db.users.find((u) => u.id === o.customerId),
    vendor: { userId: db.vendors.find((v) => v.id === o.vendorId)?.userId },
    service: { name: o.serviceId === 'svc-fan' ? 'Fan Installation' : 'AC Service' },
  });

  const prisma: any = {
    // GST rate lookup used by the extra-work bill recalculation (no configured rules here)
    taxConfig: { findMany: jest.fn(async () => []) },
    user: { findUnique: jest.fn(async ({ where }) => db.users.find((u) => matches(u, where)) ?? null) },
    serviceVendor: { findUnique: jest.fn(async ({ where }) => db.vendors.find((v) => matches(v, where)) ?? null) },
    order: {
      findMany: jest.fn(async ({ where, select }) => db.orders.filter((o) => matches(o, where)).map((o) => pick(o, select))),
      findUnique: jest.fn(async ({ where, select, include }) => {
        const o = db.orders.find((x) => x.id === where.id);
        if (!o) return null;
        if (select?.extraWorkItems) return { ...pick(o, select), extraWorkItems: db.items.filter((i) => i.orderId === o.id) };
        if (select) return pick(o, select);
        const view: Row = orderView(o);
        if (include?.extraWorkItems) view.extraWorkItems = db.items.filter((i) => i.orderId === o.id && matches(i, include.extraWorkItems.where));
        return view;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(db.orders.find((o) => o.id === where.id)!, data)),
    },
    orderAuthorizedPerson: {
      findUnique: jest.fn(async ({ where }) => db.auths.find((a) => a.orderId === where.orderId) ?? null),
      findMany: jest.fn(async ({ where, include }) => db.auths.filter((a) => matches(a, where)).map((a) => ({
        ...a, ...(include?.order ? { order: { ...pick(db.orders.find((o) => o.id === a.orderId)!, include.order.select), extraWorkItems: db.items.filter((i) => i.orderId === a.orderId) } } : {}),
      }))),
      upsert: jest.fn(async ({ where, create, update }) => {
        const existing = db.auths.find((a) => a.orderId === where.orderId);
        if (existing) return Object.assign(existing, update);
        const row = { id: `ap${++seq}`, status: 'ACTIVE', permissions: ['VIEW_ORDER', 'DECIDE_EXTRA_WORK'], revokedAt: null, relationship: null, ...create };
        db.auths.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => Object.assign(db.auths.find((a) => a.orderId === where.orderId)!, data)),
    },
    extraWorkItem: {
      create: jest.fn(async ({ data, select }) => {
        const row = { id: `x${++seq}`, otp: null, otpLastSentAt: null, approvedAt: null, createdAt: new Date(now + seq), ...data };
        db.items.push(row);
        return pick(row, select);
      }),
      findMany: jest.fn(async ({ where, select }) => db.items.filter((i) => matches(i, where)).map((i) => pick(i, select))),
      findUnique: jest.fn(async ({ where, select, include }) => {
        const row = db.items.find((i) => i.id === where.id);
        if (!row) return null;
        return include ? { ...row, order: orderView(db.orders.find((o) => o.id === row.orderId)!) } : pick(row, select);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = db.items.filter((i) => matches(i, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
    },
  };

  const authz = new AuthorizedPersonService(prisma);
  const wa: any = { sendExtraWorkApproval: jest.fn(async () => ({ delivered: true })), sendExtraWorkOtp: jest.fn() };
  const paymentNotify: any = { balanceDue: jest.fn(async () => {}) };
  const events: any = { emit: jest.fn() };
  const extras = new ExtraWorkService(prisma, wa, paymentNotify, authz, events);
  const order = (id = 'o1') => db.orders.find((o) => o.id === id)!;
  const nominatePriya = () => authz.attachFromBooking({ orderId: 'o1' }, { name: 'Priya Sharma', phone: '9822222222', relationship: 'Wife', consent: true });
  const startJob = (id = 'o1') => { order(id).status = 'STARTED'; };
  return { db, prisma, authz, extras, wa, events, paymentNotify, order, nominatePriya, startJob };
}

describe('Order creation with / without an Authorized Person', () => {
  it('booking without an authorized person is unchanged — nothing stored, response untouched', async () => {
    const w = makeWorld();
    const res = await w.authz.attachSafely({ orderId: 'o1', status: 'CONFIRMED' }, { orderId: 'o1' }, undefined);
    expect(res).toEqual({ orderId: 'o1', status: 'CONFIRMED' });
    expect(w.db.auths).toHaveLength(0);
  });

  it('stores the authorized person against the exact order, normalised, ACTIVE, with an expiry', async () => {
    const w = makeWorld();
    const res: any = await w.authz.attachSafely({ orderId: 'o1' }, { orderId: 'o1' }, { name: ' Priya Sharma ', phone: '98222 22222', relationship: 'Wife', consent: true });
    expect(res.authorizedPerson).toEqual({ saved: true });
    expect(w.db.auths).toHaveLength(1);
    expect(w.db.auths[0]).toMatchObject({ orderId: 'o1', customerId: 'u-pramod', name: 'Priya Sharma', phone: '+919822222222', relationship: 'Wife', status: 'ACTIVE' });
    expect(w.db.auths[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a cart (master) checkout authorizes every service child order of it', async () => {
    const w = makeWorld();
    const n = await w.authz.attachFromBooking({ masterOrderId: 'mo-1' }, { name: 'Priya', phone: '9822222222', consent: true });
    expect(n).toBe(1);
    expect(w.db.auths.map((a) => a.orderId)).toEqual(['o1']);
  });

  it.each([
    ['no consent', { name: 'Priya', phone: '9822222222', consent: false }],
    ['a bad mobile', { name: 'Priya', phone: '12345', consent: true }],
    ['no name', { name: '  ', phone: '9822222222', consent: true }],
  ])('rejects %s before the order is created', (_l, input) => {
    const w = makeWorld();
    expect(() => w.authz.assertValid(input as any)).toThrow(BadRequestException);
  });

  it('normalizeIndianMobile accepts common formats only', () => {
    expect(normalizeIndianMobile('+91 98222 22222')).toBe('+919822222222');
    expect(normalizeIndianMobile('919822222222')).toBe('+919822222222');
    expect(normalizeIndianMobile('5822222222')).toBeNull();
    expect(normalizeIndianMobile({} as any)).toBeNull();
  });
});

describe('Authorized Person access (their own OTP login → JWT phone)', () => {
  it('sees only the orders they are authorized for, with no customer-account data', async () => {
    const w = makeWorld();
    await w.nominatePriya();
    const list = await w.authz.listForPhone(PRIYA.phone);
    expect(list.map((x) => x.order.id)).toEqual(['o1']);
    const order: any = list[0].order;
    expect(order.orderNumber).toBe('RI-1001');
    for (const secret of ['customerId', 'guestPhone', 'customer', 'walletUsed', 'remontCommission']) expect(order[secret]).toBeUndefined();
    expect(await w.authz.listForPhone(STRANGER.phone)).toEqual([]);
  });

  it('cannot open an order they are not authorized for (same answer as not-found)', async () => {
    const w = makeWorld();
    await w.nominatePriya();
    await expect(w.authz.getForPhone(PRIYA.phone, 'o2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.authz.getForPhone(STRANGER.phone, 'o1')).rejects.toBeInstanceOf(NotFoundException);
    expect((await w.authz.getForPhone(PRIYA.phone, 'o1')).order.id).toBe('o1');
  });

  it('revoked → access and decisions denied immediately', async () => {
    const w = makeWorld();
    await w.nominatePriya();
    w.startJob();
    const item = await w.extras.addExtraWork('u-partner', 'o1', 'Switch Board Installation', 300);
    await w.authz.revoke(PRAMOD, 'o1');
    await expect(w.authz.getForPhone(PRIYA.phone, 'o1')).rejects.toBeInstanceOf(NotFoundException);
    expect(await w.authz.listForPhone(PRIYA.phone)).toEqual([]);
    await expect(w.extras.approve(PRIYA, item.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('expired → access and decisions denied', async () => {
    const w = makeWorld();
    await w.nominatePriya();
    w.startJob();
    const item = await w.extras.addExtraWork('u-partner', 'o1', 'Switch Board Installation', 300);
    w.db.auths[0].expiresAt = new Date(Date.now() - 1000);
    await expect(w.authz.getForPhone(PRIYA.phone, 'o1')).rejects.toBeInstanceOf(NotFoundException);
    expect(await w.authz.listForPhone(PRIYA.phone)).toEqual([]);
    await expect(w.extras.reject(PRIYA, item.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('only the order\'s own customer can add or revoke its authorized person', async () => {
    const w = makeWorld();
    await expect(w.authz.setForOrder(STRANGER, 'o1', { name: 'X', phone: '9833333333', consent: true })).rejects.toBeInstanceOf(NotFoundException);
    await w.authz.setForOrder(PRAMOD, 'o1', { name: 'Priya', phone: '9822222222', consent: true });
    await expect(w.authz.revoke(STRANGER, 'o1')).rejects.toBeInstanceOf(NotFoundException);
    expect(w.db.auths[0].status).toBe('ACTIVE');
  });
});

describe('Extra work decisions — customer OR authorized person, first decision wins', () => {
  async function withExtra() {
    const w = makeWorld();
    await w.nominatePriya();
    w.startJob();
    const item = await w.extras.addExtraWork('u-partner', 'o1', 'Switch Board Installation', 300);
    return { w, item };
  }

  it('partner adds extra work: PENDING, bill stays ₹500, customer AND authorized person are notified', async () => {
    const { w, item } = await withExtra();
    expect(item).toMatchObject({ status: 'PENDING', customerApproved: false });
    expect(w.order()).toMatchObject({ extraWorkAmount: 0, subtotal: 500 });
    expect(w.wa.sendExtraWorkApproval).toHaveBeenCalledWith('+919811111111', 'RI-1001', 'Switch Board Installation', 300);
    expect(w.wa.sendExtraWorkApproval).toHaveBeenCalledWith('+919822222222', 'RI-1001', 'Switch Board Installation', 300);
    expect(w.events.emit).toHaveBeenCalledWith('extraWork.requested', expect.objectContaining({
      orderId: 'o1', customerId: 'u-pramod', authorizedPhone: '+919822222222', serviceName: 'Fan Installation', amount: 300,
    }));
  });

  it('customer and authorized person both see the pending item on their order views', async () => {
    const { w } = await withExtra();
    const forPriya: any = await w.authz.getForPhone(PRIYA.phone, 'o1');
    expect(forPriya.order.extraWorkItems.map((i: any) => i.status)).toEqual(['PENDING']);
  });

  it('customer approves → APPROVED by CUSTOMER, bill ₹800, partner notified', async () => {
    const { w, item } = await withExtra();
    const res: any = await w.extras.approve(PRAMOD, item.id);
    expect(res).toMatchObject({ status: 'APPROVED', approvedByType: 'CUSTOMER', customerApproved: true });
    expect(w.db.items[0].approvedByUserId).toBe('u-pramod');
    expect(w.order()).toMatchObject({ extraWorkAmount: 300, subtotal: 800 });
    expect(w.events.emit).toHaveBeenCalledWith('extraWork.decided', expect.objectContaining({ decision: 'APPROVED', vendorUserId: 'u-partner' }));
  });

  it('authorized person approves → APPROVED by AUTHORIZED_PERSON, bill ₹800', async () => {
    const { w, item } = await withExtra();
    const res: any = await w.extras.approve(PRIYA, item.id);
    expect(res).toMatchObject({ status: 'APPROVED', approvedByType: 'AUTHORIZED_PERSON' });
    expect(w.db.items[0].approvedByUserId).toBe('u-priya');
    expect(w.order().subtotal).toBe(800);
  });

  it('only one approval is accepted — the second approver gets a conflict and billing is not doubled', async () => {
    const { w, item } = await withExtra();
    await w.extras.approve(PRIYA, item.id);
    await expect(w.extras.approve(PRAMOD, item.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(w.extras.approve(PRIYA, item.id)).rejects.toBeInstanceOf(ConflictException);
    expect(w.order()).toMatchObject({ extraWorkAmount: 300, subtotal: 800 });
    expect(w.paymentNotify.balanceDue).toHaveBeenCalledTimes(1);
  });

  it('approved cannot be rejected; rejected cannot be approved', async () => {
    const a = await withExtra();
    await a.w.extras.approve(PRAMOD, a.item.id);
    await expect(a.w.extras.reject(PRIYA, a.item.id, 'changed mind')).rejects.toBeInstanceOf(ConflictException);
    expect(a.w.db.items[0].status).toBe('APPROVED');

    const r = await withExtra();
    await r.w.extras.reject(PRIYA, r.item.id, 'Too expensive');
    await expect(r.w.extras.approve(PRAMOD, r.item.id)).rejects.toBeInstanceOf(ConflictException);
    expect(r.w.db.items[0]).toMatchObject({ status: 'REJECTED', rejectedByType: 'AUTHORIZED_PERSON', rejectionReason: 'Too expensive', customerApproved: false });
    expect(r.w.order().subtotal).toBe(500);
    expect(r.w.events.emit).toHaveBeenCalledWith('extraWork.decided', expect.objectContaining({ decision: 'REJECTED', reason: 'Too expensive' }));
  });

  it('the partner cannot approve or reject — even if they were also named as the authorized person', async () => {
    const { w, item } = await withExtra();
    w.db.auths[0].phone = PARTNER.phone;
    await expect(w.extras.approve(PARTNER, item.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.extras.reject(PARTNER, item.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.db.items[0].status).toBe('PENDING');
  });

  it('a stranger, or an authorized person of another order, cannot decide', async () => {
    const { w, item } = await withExtra();
    await expect(w.extras.approve(STRANGER, item.id)).rejects.toBeInstanceOf(ForbiddenException);
    // Priya is authorized for o1 only — an extra on o2 is out of reach.
    const other = await w.extras.addExtraWork('u-partner', 'o2', 'Gas refill', 1200);
    await expect(w.extras.approve(PRIYA, other.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a long rejection reason is trimmed; a non-string reason is refused', async () => {
    const { w, item } = await withExtra();
    await expect(w.extras.reject(PRAMOD, item.id, { evil: 1 } as any)).rejects.toBeInstanceOf(BadRequestException);
    await w.extras.reject(PRAMOD, item.id, 'x'.repeat(500));
    expect(w.db.items[0].rejectionReason).toHaveLength(300);
  });

  it('final bill with several items counts APPROVED only: ₹500 + 300 approved, 200 rejected, 150 pending = ₹800', async () => {
    const { w, item: a } = await withExtra();
    const b = await w.extras.addExtraWork('u-partner', 'o1', 'Socket repair', 200);
    await w.extras.addExtraWork('u-partner', 'o1', 'Extra wiring', 150);
    await w.extras.approve(PRAMOD, a.id);
    await w.extras.reject(PRIYA, b.id, 'not needed');
    expect(w.order()).toMatchObject({ extraWorkAmount: 300, subtotal: 800 });
  });

  it('a price change after approval is a NEW pending request; the approved amount never changes', async () => {
    const { w, item } = await withExtra();
    await w.extras.approve(PRAMOD, item.id);
    const revised = await w.extras.addExtraWork('u-partner', 'o1', 'Switch Board Installation (revised)', 350);
    expect(revised.id).not.toBe(item.id);
    expect(w.db.items.find((i) => i.id === item.id)).toMatchObject({ amount: 300, status: 'APPROVED' });
    expect(w.order().subtotal).toBe(800);
  });

  it('decisions are closed once the job is completed — pending stays unbilled', async () => {
    const { w, item } = await withExtra();
    w.order().status = 'COMPLETED';
    await expect(w.extras.approve(PRIYA, item.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(w.order().subtotal).toBe(500);
  });

  it('an order without an authorized person works exactly as before (customer decides)', async () => {
    const w = makeWorld();
    w.startJob();
    const item = await w.extras.addExtraWork('u-partner', 'o1', 'Switch Board Installation', 300);
    expect(w.wa.sendExtraWorkApproval).toHaveBeenCalledTimes(1);
    expect(w.events.emit).toHaveBeenCalledWith('extraWork.requested', expect.objectContaining({ authorizedPhone: null }));
    await expect(w.extras.approve(PRIYA, item.id)).rejects.toBeInstanceOf(ForbiddenException);
    await w.extras.approve(PRAMOD, item.id);
    expect(w.order().subtotal).toBe(800);
  });
});
