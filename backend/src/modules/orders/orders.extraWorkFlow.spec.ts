import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ExtraWorkService } from './orders.module';

/**
 * Extra work end to end against an in-memory store: partner adds → customer gets the OTP →
 * partner enters it → items approved → bill (subtotal) updated. Original job ₹500, extra ₹300.
 * The fake WhatsApp service records the code it was asked to deliver (the only way a test can
 * know it — the API never returns it) and can simulate a provider failure.
 */
type Row = Record<string, any>;

function makeFlow(orderOverrides: Row = {}) {
  const db = {
    vendors: [{ id: 'sv-1', userId: 'partner-user' }, { id: 'sv-2', userId: 'other-partner' }],
    order: {
      id: 'o1', orderNumber: 'RI-1001', vendorId: 'sv-1', customerId: 'cust-1', guestPhone: null,
      customer: { id: 'cust-1', phone: '+919000000001' },
      status: 'STARTED', serviceAmount: 500, productsAmount: 0, couponDiscount: 0, membershipDiscount: 0,
      walletUsed: 0, remontCommission: 100, extraWorkAmount: 0, subtotal: 500, totalAmount: 590,
      ...orderOverrides,
    } as Row,
    items: [] as Row[],
  };
  let seq = 0;
  const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) =>
    v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v);
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });

  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(async ({ where }) => db.vendors.find((v) => v.userId === where.userId) ?? null) },
    order: {
      findUnique: jest.fn(async ({ include }) => {
        const o = { ...db.order };
        if (include?.extraWorkItems) o.extraWorkItems = db.items.filter((i) => matches(i, include.extraWorkItems.where));
        return o;
      }),
      update: jest.fn(async ({ data }) => Object.assign(db.order, data)),
    },
    extraWorkItem: {
      create: jest.fn(async ({ data }) => {
        const row = { id: `x${++seq}`, otp: null, otpVerified: false, otpLastSentAt: null, approvedAt: null, createdAt: new Date(Date.now() + seq), ...data };
        db.items.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, select }) => db.items.filter((i) => matches(i, where)).map((i) => pick(i, select))),
      findUnique: jest.fn(async ({ where, include, select }) => {
        const row = db.items.find((i) => i.id === where.id);
        if (!row) return null;
        return include ? { ...row, order: { ...db.order } } : pick(row, select);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = db.items.filter((i) => matches(i, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
    },
  };

  const sms = { sent: [] as { phone: string; otp: string; amount?: number }[], deliver: true };
  const wa: any = {
    sendExtraWorkApproval: jest.fn(async () => ({ delivered: true })),
    sendExtraWorkOtp: jest.fn(async (phone: string, _order: string, otp: string, amount?: number) => {
      sms.sent.push({ phone, otp, amount });
      return { delivered: sms.deliver };
    }),
  };
  const paymentNotify: any = { balanceDue: jest.fn(async () => {}) };
  const svc = new ExtraWorkService(prisma, wa, paymentNotify);
  const lastOtp = () => sms.sent[sms.sent.length - 1].otp;
  const age = (ms: number) => db.items.forEach((i) => { if (i.otpLastSentAt) i.otpLastSentAt = new Date(Date.now() - ms); });
  return { svc, db, sms, wa, paymentNotify, lastOtp, age };
}

const PARTNER = 'partner-user';

describe('Extra work: partner adds, customer confirms by OTP, bill follows approval', () => {
  it('creates the item as pending and does not bill it (bill stays ₹500)', async () => {
    const f = makeFlow();
    const item = await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    expect(item.customerApproved).toBe(false);
    expect(f.db.order).toMatchObject({ status: 'EXTRA_WORK_ADDED', extraWorkAmount: 0, subtotal: 500 });
    expect(f.wa.sendExtraWorkApproval).toHaveBeenCalledWith('+919000000001', 'RI-1001', 'Switch Board Installation', 300);
  });

  it('sends a fresh 4-digit OTP to the customer phone with the amount, never returns it, and approves on the right code (bill ₹800)', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);

    const res: any = await f.svc.requestOtp(PARTNER, 'o1');
    expect(f.sms.sent).toHaveLength(1);
    expect(f.sms.sent[0]).toMatchObject({ phone: '+919000000001', amount: 300 });
    expect(f.lastOtp()).toMatch(/^\d{4}$/);
    expect(JSON.stringify(res)).not.toContain(f.lastOtp());

    const approved: any[] = await f.svc.verifyOtp(PARTNER, 'o1', f.lastOtp());
    expect(approved.map((i) => i.customerApproved)).toEqual([true]);
    expect(JSON.stringify(approved)).not.toContain('"otp"');
    expect(f.db.items[0]).toMatchObject({ customerApproved: true, otpVerified: true, otp: null });
    expect(f.db.order).toMatchObject({ extraWorkAmount: 300, subtotal: 800 });
  });

  it('one OTP confirms every pending item the partner sent — all billed, counted once (₹500 + 300 + 150)', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.addExtraWork(PARTNER, 'o1', 'Extra wiring', 150);
    await f.svc.requestOtp(PARTNER, 'o1');
    expect(f.sms.sent[0].amount).toBe(450);

    await f.svc.verifyOtp(PARTNER, 'o1', f.lastOtp());
    expect(f.db.items.every((i) => i.customerApproved)).toBe(true);
    expect(f.db.order).toMatchObject({ extraWorkAmount: 450, subtotal: 950 });
  });

  it('a wrong OTP fails and bills nothing', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.requestOtp(PARTNER, 'o1');
    const wrong = f.lastOtp() === '1111' ? '2222' : '1111';
    await expect(f.svc.verifyOtp(PARTNER, 'o1', wrong)).rejects.toThrow('Invalid OTP');
    expect(f.db.items[0].customerApproved).toBe(false);
    expect(f.db.order.subtotal).toBe(500);
  });

  it('an expired OTP (older than 10 min) fails and bills nothing', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.requestOtp(PARTNER, 'o1');
    f.age(11 * 60 * 1000);
    await expect(f.svc.verifyOtp(PARTNER, 'o1', f.lastOtp())).rejects.toThrow(/expired/);
    expect(f.db.items[0].customerApproved).toBe(false);
    expect(f.db.order.subtotal).toBe(500);
  });

  it('an OTP cannot be reused — the replay approves nothing more and bills once', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.requestOtp(PARTNER, 'o1');
    const otp = f.lastOtp();
    await f.svc.verifyOtp(PARTNER, 'o1', otp);
    await f.svc.addExtraWork(PARTNER, 'o1', 'Another item', 100);
    await expect(f.svc.verifyOtp(PARTNER, 'o1', otp)).rejects.toThrow('Invalid OTP');
    expect(f.db.items[1].customerApproved).toBe(false);
    expect(f.db.order).toMatchObject({ extraWorkAmount: 300, subtotal: 800 });
  });

  it('resend: respects the cooldown, then issues a new code and the old one stops working', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.requestOtp(PARTNER, 'o1');
    const first = f.lastOtp();
    await expect(f.svc.requestOtp(PARTNER, 'o1')).rejects.toThrow(/Please wait/);

    f.age(60 * 1000);
    let second = first;
    // a fresh code is random — retry past the cooldown until it differs from the first
    for (let i = 0; i < 5 && second === first; i++) { f.age(60 * 1000); await f.svc.requestOtp(PARTNER, 'o1'); second = f.lastOtp(); }
    expect(second).not.toBe(first);
    await expect(f.svc.verifyOtp(PARTNER, 'o1', first)).rejects.toThrow('Invalid OTP');
    await f.svc.verifyOtp(PARTNER, 'o1', second);
    expect(f.db.order.subtotal).toBe(800);
  });

  it('when the SMS provider does not accept the message, requestOtp fails honestly and leaves no live code', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    f.sms.deliver = false;
    await expect(f.svc.requestOtp(PARTNER, 'o1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.db.items[0]).toMatchObject({ otp: null, otpLastSentAt: null, customerApproved: false });
    f.sms.deliver = true;
    await f.svc.requestOtp(PARTNER, 'o1'); // no cooldown left behind by the failed attempt
    expect(f.sms.sent).toHaveLength(2);
  });

  it('a partner not assigned to the job can neither request nor verify the OTP', async () => {
    const f = makeFlow();
    await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.requestOtp(PARTNER, 'o1');
    await expect(f.svc.requestOtp('other-partner', 'o1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.svc.verifyOtp('other-partner', 'o1', f.lastOtp())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.svc.addExtraWork('other-partner', 'o1', 'x', 10)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the partner cannot approve through the customer approval endpoint', async () => {
    const f = makeFlow();
    const item = await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await expect(f.svc.approve({ sub: PARTNER } as any, item.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.order.subtotal).toBe(500);
  });

  it('another customer cannot approve this customer\'s extra work', async () => {
    const f = makeFlow();
    const item = await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await expect(f.svc.approve({ sub: 'cust-2', phone: '+919000000002' } as any, item.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.order.subtotal).toBe(500);
  });

  it('the owning customer can approve in their app; a second approval is refused and bills/notifies once', async () => {
    const f = makeFlow();
    const item = await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.approve({ sub: 'cust-1' } as any, item.id);
    await expect(f.svc.approve({ sub: 'cust-1' } as any, item.id)).rejects.toBeInstanceOf(ConflictException);
    expect(f.db.order).toMatchObject({ extraWorkAmount: 300, subtotal: 800 });
    expect(f.paymentNotify.balanceDue).toHaveBeenCalledTimes(1);
  });

  it('after the job is completed, pending extra work stays unbilled and can no longer be approved', async () => {
    const f = makeFlow();
    const item = await f.svc.addExtraWork(PARTNER, 'o1', 'Switch Board Installation', 300);
    await f.svc.requestOtp(PARTNER, 'o1');
    const otp = f.lastOtp();
    f.db.order.status = 'COMPLETED';
    await expect(f.svc.verifyOtp(PARTNER, 'o1', otp)).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.svc.approve({ sub: 'cust-1' } as any, item.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.order.subtotal).toBe(500);
  });

  it('extra work cannot be added outside an in-progress job, or with a non-positive amount', async () => {
    const f = makeFlow({ status: 'VENDOR_ASSIGNED' });
    await expect(f.svc.addExtraWork(PARTNER, 'o1', 'x', 300)).rejects.toBeInstanceOf(BadRequestException);
    const g = makeFlow();
    await expect(g.svc.addExtraWork(PARTNER, 'o1', 'x', 0)).rejects.toBeInstanceOf(BadRequestException);
  });
});
