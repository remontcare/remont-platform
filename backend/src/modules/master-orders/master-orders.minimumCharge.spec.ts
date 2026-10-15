import { MasterOrdersService, PublicMasterOrderController } from './master-orders.module';

/**
 * Minimum service charge (CommissionRule ruleType=MINIMUM_CHARGE) through the REAL checkout()
 * and quote(): per service booking, GST-inclusive, commission on the raised amount, scoped by
 * service/category/city like every other rule — and quote() returns exactly what checkout()
 * charges while writing nothing. The commission-rule mock filters like the real query does
 * (ruleType, isActive, service-or-category, city).
 */
const CAT_HANDYMAN = 'cat-handyman';
const CAT_AC = 'cat-ac';
const SERVICES: Record<string, any> = {
  tiny: { id: 'tiny', categoryId: CAT_HANDYMAN, basePrice: 5, isActive: true, paymentMode: 'ANY' },
  small: { id: 'small', categoryId: CAT_HANDYMAN, basePrice: 150, isActive: true, paymentMode: 'ANY' },
  'at-threshold': { id: 'at-threshold', categoryId: CAT_HANDYMAN, basePrice: 199, isActive: true, paymentMode: 'ANY' },
  big: { id: 'big', categoryId: CAT_HANDYMAN, basePrice: 500, isActive: true, paymentMode: 'ANY' },
  hundred: { id: 'hundred', categoryId: CAT_HANDYMAN, basePrice: 100, isActive: true, paymentMode: 'ANY' },
  'ac-tiny': { id: 'ac-tiny', categoryId: CAT_AC, basePrice: 10, isActive: true, paymentMode: 'ANY' },
};
const CITY_BHOPAL = { id: 'city-bhopal', name: 'Bhopal', isActive: true };
const CITY_INDORE = { id: 'city-indore', name: 'Indore', isActive: true };

type Rule = { id: string; ruleType: string; scope: 'CATEGORY' | 'SERVICE'; categoryId: string | null; serviceId: string | null; cityId: string | null; commissionType: string; value: number; slabJson: null; priority: number; stackable: boolean; isActive: boolean };
const rule = (r: Partial<Rule> & { id: string; ruleType: string; value: number }): Rule => ({
  scope: 'CATEGORY', categoryId: CAT_HANDYMAN, serviceId: null, cityId: null, commissionType: 'FLAT', slabJson: null, priority: 0, stackable: false, isActive: true, ...r,
});

function makeService(rules: Rule[]) {
  const createdOrders: any[] = [];
  const createdMasterOrders: any[] = [];
  const prisma: any = {
    user: { findUnique: jest.fn(async () => null), create: jest.fn() },
    service: { findMany: jest.fn(async ({ where }: any) => Object.values(SERVICES).filter((s) => where.id.in.includes(s.id))) },
    product: { findMany: jest.fn(async () => []) },
    address: { findUnique: jest.fn(async () => ({ id: 'addr-1', userId: 'cust-1', fullAddress: 'x', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462001', latitude: 23.2, longitude: 77.4 })), create: jest.fn() },
    commissionRule: {
      findMany: jest.fn(async ({ where }: any) => rules.filter((r) =>
        r.isActive && r.ruleType === where.ruleType
        && (r.serviceId === where.OR[0].serviceId || (r.categoryId === where.OR[1].categoryId && r.serviceId === null))
        // city clause: { OR: [{cityId:null},{cityId}] } for a known city, { cityId: null } otherwise
        && (r.cityId === null || (!!where.AND[0].OR && r.cityId === where.AND[0].OR[1].cityId)))),
    },
    city: { findFirst: jest.fn(async ({ where }: any) => [CITY_BHOPAL, CITY_INDORE].find((c) => c.name.toLowerCase() === String(where.name.equals).toLowerCase()) || null) },
    taxConfig: { findMany: jest.fn(async () => []) }, // nothing configured → 18% fallback (today's checkout)
    siteSetting: { findUnique: jest.fn(async () => null) },
    masterOrder: { count: jest.fn(async () => 0), findUnique: jest.fn(async () => null) },
    walletTransaction: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn({
      masterOrder: { create: jest.fn(async ({ data }: any) => { const mo = { id: 'mo-1', ...data }; createdMasterOrders.push(mo); return mo; }), update: jest.fn() },
      order: { create: jest.fn(async ({ data }: any) => { const o = { id: 'order-' + createdOrders.length, ...data }; createdOrders.push(o); return o; }), update: jest.fn() },
      orderTimeline: { create: jest.fn(async () => ({})) },
      orderOtpLog: { create: jest.fn(async () => ({})) },
      orderDiscountAllocation: { create: jest.fn(async () => ({})) },
    })),
  };
  const memberships: any = { getActiveDiscount: jest.fn(async () => 0) };
  const coupons: any = { validate: jest.fn(), recordUsage: jest.fn() };
  const cities: any = {
    getByName: jest.fn(async (name: string) => [CITY_BHOPAL, CITY_INDORE].find((c) => c.name === name) || null),
    getServicePrice: jest.fn(async () => null),
  };
  const payments: any = { initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'o', keyId: 'k', txId: 't' })) };
  const svc = new MasterOrdersService(
    prisma, coupons, memberships, cities, payments, { dispatch: jest.fn(async () => []) } as any, { route: jest.fn(async () => {}) } as any,
    { paymentSuccess: jest.fn(async () => {}) } as any, { createShipmentForOrder: jest.fn() } as any,
    { checkEligibility: jest.fn(async () => ({ tier: 'STANDARD', charge: 0 })) } as any, { notify: jest.fn() } as any,
  );
  return { svc, prisma, createdOrders, memberships };
}

const cart = (...ids: string[]) => ({ items: ids.map((serviceId) => ({ type: 'SERVICE', serviceId, quantity: 1 })), addressId: 'addr-1' }) as any;
const checkout = (svc: MasterOrdersService, dto: any) => svc.checkout(dto, { customerId: 'cust-1', paymentMethod: 'COD' });

describe('Minimum service charge — per booking, GST-inclusive', () => {
  const MIN_199 = rule({ id: 'min-199', ruleType: 'MINIMUM_CHARGE', value: 199 });
  const COMM_20 = rule({ id: 'comm-20', ruleType: 'COMMISSION', commissionType: 'PERCENTAGE', value: 20 });

  it('no MINIMUM_CHARGE rule → checkout is exactly as before (₹300 + 18% = ₹354)', async () => {
    const { svc, createdOrders } = makeService([]);
    SERVICES.mid = { id: 'mid', categoryId: CAT_HANDYMAN, basePrice: 300, isActive: true, paymentMode: 'ANY' };
    await checkout(svc, cart('mid'));
    expect(Number(createdOrders[0].totalAmount)).toBe(354);
    expect(Number(createdOrders[0].minimumChargeAdjustment)).toBe(0);
    delete SERVICES.mid;
  });

  it.each([
    ['tiny', 5, 199, 168.64, 30.36],
    ['small', 150, 199, 168.64, 30.36],
  ])('%s (₹%d) is raised so the customer pays exactly ₹%d incl. GST', async (id, _price, total, service, gst) => {
    const { svc, createdOrders } = makeService([MIN_199]);
    await checkout(svc, cart(id as string));
    const o = createdOrders[0];
    expect(Number(o.serviceAmount)).toBe(service);
    expect(Number(o.gstAmount)).toBe(gst);
    expect(Number(o.totalAmount)).toBe(total);
    expect(Number(o.minimumChargeAdjustment)).toBeCloseTo(service - SERVICES[id as string].basePrice, 2);
    expect(o.minimumChargeRuleId).toBe('min-199');
  });

  it.each([['at-threshold', 234.82], ['big', 590]])('%s is already above the GST-inclusive minimum → unchanged (₹%d)', async (id, total) => {
    const { svc, createdOrders } = makeService([MIN_199]);
    await checkout(svc, cart(id as string));
    expect(Number(createdOrders[0].totalAmount)).toBe(total);
    expect(Number(createdOrders[0].minimumChargeAdjustment)).toBe(0);
  });

  it('applies per booking, not per line: two ₹100 services in one booking (₹236 incl. GST) need no top-up', async () => {
    const { svc, createdOrders } = makeService([MIN_199]);
    await checkout(svc, cart('hundred', 'tiny'));
    // 100 + 5 = 105 → 123.90 incl. GST < 199 → ONE top-up for the booking, not two
    expect(createdOrders).toHaveLength(1);
    expect(Number(createdOrders[0].totalAmount)).toBe(199);
    const { svc: svc2, createdOrders: o2 } = makeService([MIN_199]);
    SERVICES.hundred2 = { ...SERVICES.hundred, id: 'hundred2' };
    await checkout(svc2, cart('hundred', 'hundred2'));
    expect(Number(o2[0].totalAmount)).toBe(236);
    expect(Number(o2[0].minimumChargeAdjustment)).toBe(0);
    delete SERVICES.hundred2;
  });

  it('commission (existing rules) is computed on the raised amount, and deducted from the partner once', async () => {
    const { svc, createdOrders } = makeService([MIN_199, COMM_20]);
    await checkout(svc, cart('tiny'));
    const o = createdOrders[0];
    expect(Number(o.remontCommission)).toBe(33.73); // 20% of 168.64
    expect(Number(o.vendorPayout)).toBe(134.91); // 168.64 − 33.73 — the customer is never charged it again
  });

  it('a city-specific minimum beats the all-city one; other cities keep the all-city minimum', async () => {
    const rules = [MIN_199, rule({ id: 'min-bhopal-299', ruleType: 'MINIMUM_CHARGE', value: 299, cityId: CITY_BHOPAL.id })];
    const a = makeService(rules);
    await checkout(a.svc, { ...cart('tiny'), city: 'Bhopal' });
    expect(Number(a.createdOrders[0].totalAmount)).toBe(299);
    const b = makeService(rules);
    await checkout(b.svc, { ...cart('tiny'), city: 'Indore' });
    expect(Number(b.createdOrders[0].totalAmount)).toBe(199);
  });

  it('a service-level minimum overrides its category minimum; other categories are unaffected', async () => {
    const rules = [MIN_199, rule({ id: 'min-tiny-99', ruleType: 'MINIMUM_CHARGE', scope: 'SERVICE', serviceId: 'tiny', value: 99 })];
    const a = makeService(rules);
    await checkout(a.svc, cart('tiny'));
    expect(Number(a.createdOrders[0].totalAmount)).toBe(99);
    const b = makeService(rules);
    await checkout(b.svc, cart('ac-tiny')); // AC category has no minimum rule
    expect(Number(b.createdOrders[0].totalAmount)).toBe(11.8);
  });

  it('an inactive minimum rule is ignored', async () => {
    const { svc, createdOrders } = makeService([{ ...MIN_199, isActive: false }]);
    await checkout(svc, cart('tiny'));
    expect(Number(createdOrders[0].totalAmount)).toBe(5.9);
  });

  it('a cancellation-charge rule never affects the price (separate rule type)', async () => {
    const { svc, createdOrders } = makeService([rule({ id: 'cancel-500', ruleType: 'CANCELLATION_CHARGE', value: 500 })]);
    await checkout(svc, cart('tiny'));
    expect(Number(createdOrders[0].totalAmount)).toBe(5.9);
  });
});

describe('quote() = checkout() and writes nothing', () => {
  const rules = [rule({ id: 'min-199', ruleType: 'MINIMUM_CHARGE', value: 199 }), rule({ id: 'comm-20', ruleType: 'COMMISSION', commissionType: 'PERCENTAGE', value: 20 })];

  it.each([['tiny'], ['big'], ['hundred', 'tiny']])('cart %p: quote total equals the checkout total', async (...ids) => {
    const q = makeService(rules);
    const quote = await q.svc.quote(cart(...ids), { customerId: 'cust-1' });
    expect(q.prisma.$transaction).not.toHaveBeenCalled();
    expect(q.prisma.user.create).not.toHaveBeenCalled();
    expect(q.prisma.address.create).not.toHaveBeenCalled();
    const c = makeService(rules);
    const result: any = await checkout(c.svc, cart(...ids));
    expect(quote.totalAmount).toBe(Number(result.totalAmount));
    expect(quote.gstAmount).toBe(Number(c.createdOrders.reduce((s: number, o: any) => s + Number(o.gstAmount), 0).toFixed(2)));
  });

  it('exposes the minimum-charge top-up but never commission or partner payout', async () => {
    const q = makeService(rules);
    const quote: any = await q.svc.quote(cart('tiny'), {});
    expect(quote.minimumChargeAdjustment).toBe(163.64);
    expect(quote.totalAmount).toBe(199);
    expect(JSON.stringify(quote)).not.toMatch(/commission|vendorPayout/i);
  });

  it('an inline address is priced from its coordinates without creating an Address row', async () => {
    const q = makeService(rules);
    await q.svc.quote({ items: [{ type: 'SERVICE', serviceId: 'tiny', quantity: 1 }], inlineAddress: { fullAddress: 'x', city: 'Bhopal', latitude: 23.2, longitude: 77.4 } } as any, {});
    expect(q.prisma.address.create).not.toHaveBeenCalled();
  });

  it("a quote never prices from someone else's saved address", async () => {
    const q = makeService(rules);
    q.prisma.address.findUnique.mockResolvedValueOnce({ id: 'addr-2', userId: 'someone-else', city: 'Bhopal', latitude: 1, longitude: 1 });
    const quote = await q.svc.quote({ items: [{ type: 'SERVICE', serviceId: 'tiny', quantity: 1 }], addressId: 'addr-2' } as any, { customerId: 'cust-1' });
    expect(quote.totalAmount).toBe(199); // priced fine, the foreign address simply isn't used
  });
});

describe('Audit H1 — the booking city comes from the customer\'s own address when no city name is sent', () => {
  const MIN_BHOPAL = rule({ id: 'min-bhopal', ruleType: 'MINIMUM_CHARGE', value: 199, cityId: CITY_BHOPAL.id });
  const MIN_INDORE = rule({ id: 'min-indore', ruleType: 'MINIMUM_CHARGE', value: 500, cityId: CITY_INDORE.id, priority: 50 });

  it('no city name + saved address in Bhopal → Bhopal\'s minimum (₹199), never Indore\'s ₹500', async () => {
    const { svc } = makeService([MIN_BHOPAL, MIN_INDORE]);
    const q = await svc.quote(cart('tiny'), { customerId: 'cust-1' }); // cart() sends addressId only, no city
    expect(q.totalAmount).toBe(199);
  });

  it('address in an unrecognised city → only all-city rules (here: none → unchanged ₹5.90)', async () => {
    const { svc, prisma } = makeService([MIN_BHOPAL, MIN_INDORE]);
    prisma.address.findUnique.mockResolvedValue({ id: 'addr-1', userId: 'cust-1', city: 'Atlantis', latitude: 23.2, longitude: 77.4 });
    expect((await svc.quote(cart('tiny'), { customerId: 'cust-1' })).totalAmount).toBe(5.9);
  });

  it('someone else\'s saved address is never used to pick the city', async () => {
    const { svc, prisma } = makeService([MIN_BHOPAL, MIN_INDORE]);
    prisma.address.findUnique.mockResolvedValue({ id: 'addr-x', userId: 'someone-else', city: 'Indore', latitude: 23.2, longitude: 77.4 });
    expect((await svc.quote(cart('tiny'), { customerId: 'cust-1' })).totalAmount).toBe(5.9);
  });
});

describe('Audit M5 — the public quote never reveals another person\'s membership', () => {
  const items = [{ type: 'SERVICE', serviceId: 'big', quantity: 1 }];
  function withMember() {
    const t = makeService([]);
    t.memberships.getActiveDiscount.mockImplementation(async (id: string) => (id === 'cust-1' ? 10 : 0));
    t.prisma.user.findUnique.mockResolvedValue({ id: 'cust-1', phone: '+919999999999' });
    return t;
  }

  it('a typed phone number is ignored: no user lookup, no membership discount', async () => {
    const t = withMember();
    const q = await new PublicMasterOrderController(t.svc).quote({ items, phone: '+919999999999', city: 'Bhopal' } as any);
    expect(t.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(t.memberships.getActiveDiscount).not.toHaveBeenCalled();
    expect(q.membershipDiscount).toBe(0);
  });

  it('the logged-in customer\'s own quote still includes their membership', async () => {
    const t = withMember();
    const q = await t.svc.quote({ items, city: 'Bhopal' } as any, { customerId: 'cust-1' });
    expect(q.membershipDiscount).toBeGreaterThan(0);
  });

  it('a guest checkout never gets the membership of the account behind a typed phone number — it pays the non-member price', async () => {
    const t = withMember();
    const own = await t.svc.quote({ items, city: 'Bhopal' } as any, { customerId: 'cust-1' });
    const anon = await t.svc.quote({ items, city: 'Bhopal' } as any, {});
    const res: any = await t.svc.checkout({ items, city: 'Bhopal', addressId: 'addr-1' } as any,
      { guestPhone: '+919999999999', guestName: 'Guest', paymentMethod: 'COD' } as any);
    expect(own.membershipDiscount).toBeGreaterThan(0);
    expect(Number(res.totalAmount)).toBe(anon.totalAmount);
    expect(Number(res.totalAmount)).toBeGreaterThan(own.totalAmount);
  });
});
