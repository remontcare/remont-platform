import { OrdersService, GuestBookingService } from './orders.module';

/**
 * The legacy single-order path (POST /orders — used by the Partner/customer app) and the
 * direct guest booking apply the same minimum service charge and shared GST source as the
 * cart checkout, and POST /orders/quote returns exactly what POST /orders then charges,
 * without creating anything.
 */
const SERVICE = { id: 'svc-tiny', categoryId: 'cat-1', basePrice: 5, hsnSac: null, gstOverridePercent: null, isActive: true, durationMinutes: 60, name: 'Tiny job' };
const PRODUCT = { id: 'p1', categoryId: 'pc-1', vendorId: null, price: 100, hsnSac: null, gstOverridePercent: null, gstInclusive: null, isActive: true };
const RULES = [
  { id: 'min-199', ruleType: 'MINIMUM_CHARGE', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'FLAT', value: 199, slabJson: null, priority: 0, stackable: false, isActive: true },
  { id: 'comm-20', ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'PERCENTAGE', value: 20, slabJson: null, priority: 0, stackable: false, isActive: true },
];

function makeService(rules = RULES) {
  const prisma: any = {
    service: { findUnique: jest.fn(async () => SERVICE) },
    product: { findUnique: jest.fn(async () => PRODUCT), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    address: { create: jest.fn(async ({ data }: any) => ({ id: 'addr-1', ...data })), findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ id: 'cust-1', phone: '+919999999999' })), create: jest.fn() },
    order: { create: jest.fn(async ({ data }: any) => ({ id: 'order-1', orderNumber: 'ORD-1', ...data })), findUnique: jest.fn(async () => null) },
    orderOtpLog: { create: jest.fn(async () => ({})) },
    orderTimeline: { create: jest.fn(async () => ({})) },
    orderDiscountAllocation: { create: jest.fn(async () => ({})) },
    taxConfig: { findMany: jest.fn(async () => []) },
    productFeeRule: { findMany: jest.fn(async () => []) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    commissionRule: { findMany: jest.fn(async ({ where }: any) => rules.filter((r) => r.ruleType === where.ruleType)) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const memberships: any = { getActiveDiscount: jest.fn(async () => 0) };
  const coupons: any = { validate: jest.fn(), recordUsage: jest.fn() };
  const cities: any = { getByName: jest.fn(async () => null), getServicePrice: jest.fn(async () => null) };
  const payments: any = { initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_1', keyId: 'key_1' })) };
  const svc = new OrdersService(prisma, coupons, memberships, {} as any, {} as any, cities, payments, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, cities, payments };
}

describe('POST /orders (legacy path) — minimum charge + quote', () => {
  it('a ₹5 service is raised to ₹199 incl. GST; commission on the raised amount', async () => {
    const { svc } = makeService();
    const order: any = await svc.create('cust-1', { type: 'SERVICE', serviceId: 'svc-tiny' } as any);
    expect(Number(order.totalAmount)).toBe(199);
    expect(Number(order.serviceAmount)).toBe(168.64);
    expect(Number(order.minimumChargeAdjustment)).toBe(163.64);
    expect(Number(order.remontCommission)).toBe(33.73);
  });

  it.each([
    [{ type: 'SERVICE', serviceId: 'svc-tiny' }],
    [{ type: 'BUNDLE', serviceId: 'svc-tiny', items: [{ productId: 'p1', quantity: 2 }] }],
  ])('quote(%p) equals the order create() then charges, and creates nothing', async (dto) => {
    const q = makeService();
    const quote = await q.svc.quote('cust-1', dto as any);
    expect(q.prisma.order.create).not.toHaveBeenCalled();
    expect(q.prisma.address.create).not.toHaveBeenCalled();
    const c = makeService();
    const order: any = await c.svc.create('cust-1', dto as any);
    expect(quote.totalAmount).toBe(Number(order.totalAmount));
    expect(quote.gstAmount).toBe(Number(order.gstAmount));
  });

  it('no minimum rule → unchanged (₹5 + 18% = ₹5.90)', async () => {
    const { svc } = makeService([]);
    const order: any = await svc.create('cust-1', { type: 'SERVICE', serviceId: 'svc-tiny' } as any);
    expect(Number(order.totalAmount)).toBe(5.9);
  });
});

describe('Direct guest booking (POST /orders/public/book) — same minimum', () => {
  it('charges the GST-inclusive minimum for a below-minimum service', async () => {
    const { prisma, cities, payments } = makeService();
    cities.getByName = jest.fn();
    prisma.city = { findUnique: jest.fn(async () => ({ id: 'city-1', name: 'Bhopal', isActive: true, latitude: 23.2, longitude: 77.4 })), findFirst: jest.fn() };
    const guest = new GuestBookingService(prisma, { dispatch: jest.fn(async () => []) } as any, { route: jest.fn() } as any, payments, cities, { bookingConfirmed: jest.fn() } as any);
    await guest.book({ name: 'A', phone: '+919999999999', serviceId: 'svc-tiny', cityId: 'city-1', address: 'x', slotDate: '2026-12-01', slotTime: '10:00', paymentMethod: 'COD' } as any).catch(() => undefined);
    const created = prisma.order.create.mock.calls[0]?.[0]?.data;
    expect(created).toBeDefined();
    expect(Number(created.totalAmount)).toBe(199);
    expect(Number(created.minimumChargeAdjustment)).toBe(163.64);
  });
});

describe('Audit H1 — the app (no city name) is priced by its own saved address\'s city', () => {
  const cityRule = (id: string, cityId: string, value: number, priority = 0) =>
    ({ id, ruleType: 'MINIMUM_CHARGE', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId, commissionType: 'FLAT', value, slabJson: null, priority, stackable: false, isActive: true });
  function appSvc(addressCity: string, addressOwner = 'cust-1') {
    const rules = [cityRule('min-bhopal', 'city-bhopal', 199), cityRule('min-indore', 'city-indore', 500, 50)];
    const t = makeService(rules as any);
    // the real query's city clause: this city's rules + all-city rules, or all-city only
    t.prisma.commissionRule.findMany = jest.fn(async ({ where }: any) => rules.filter((r) => r.ruleType === where.ruleType
      && (where.AND[0].OR ? r.cityId === null || r.cityId === where.AND[0].OR[1].cityId : r.cityId === null)));
    t.prisma.address.findUnique = jest.fn(async () => ({ id: 'addr-1', userId: addressOwner, city: addressCity }));
    t.prisma.city = { findFirst: jest.fn(async ({ where }: any) => ({ bhopal: { id: 'city-bhopal' }, indore: { id: 'city-indore' } } as any)[String(where.name.equals).toLowerCase()] ?? null) };
    return t;
  }
  it('saved address in Bhopal → Bhopal\'s ₹199 minimum (not Indore\'s ₹500)', async () => {
    const q = await appSvc('Bhopal').svc.quote('cust-1', { type: 'SERVICE', serviceId: 'svc-tiny', addressId: 'addr-1' } as any);
    expect(q.totalAmount).toBe(199);
  });
  it('saved address in Indore → Indore\'s ₹500', async () => {
    const q = await appSvc('Indore').svc.quote('cust-1', { type: 'SERVICE', serviceId: 'svc-tiny', addressId: 'addr-1' } as any);
    expect(q.totalAmount).toBe(500);
  });
  it('another customer\'s address id → no city → no city-scoped minimum (₹5.90)', async () => {
    const q = await appSvc('Indore', 'someone-else').svc.quote('cust-1', { type: 'SERVICE', serviceId: 'svc-tiny', addressId: 'addr-1' } as any);
    expect(q.totalAmount).toBe(5.9);
  });
});
