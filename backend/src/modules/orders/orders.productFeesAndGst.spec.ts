import { OrdersService, GuestBookingService } from './orders.module';

/**
 * Phase 8 — create() and publicProductCheckout() previously (a) computed a hardcoded flat
 * 18% GST on the whole cart, ignoring TaxConfig/HSN/gstOverridePercent/gstInclusive
 * entirely, and (b) never called resolveProductFee() at all, so remontCommission/
 * vendorPayout were hardcoded to 0/gross for every product bought through either path.
 * This file is the regression guard for both fixes.
 */

const PRODUCT_EXCL = { id: 'excl-product', categoryId: 'cat-1', vendorId: 'seller-a', price: 1000, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCT_INCL = { id: 'incl-product', categoryId: 'cat-1', vendorId: 'seller-a', price: 1180, hsnSac: 'HSN-INCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCTS: Record<string, any> = { 'excl-product': PRODUCT_EXCL, 'incl-product': PRODUCT_INCL };

const TAX_CONFIG_ROWS = [
  { rate: 12, hsnCode: 'HSN-EXCL', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-01') },
  { rate: 18, hsnCode: 'HSN-INCL', appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-02') },
];

function makeService() {
  const prisma: any = {
    product: { findUnique: jest.fn(async ({ where }: any) => PRODUCTS[where.id] || null) },
    address: { create: jest.fn(async ({ data }: any) => ({ id: 'addr-1', ...data })), findUnique: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ id: 'user-1', name: null, phone: '+919999999999' })), create: jest.fn(), update: jest.fn() },
    order: { create: jest.fn(async ({ data }: any) => ({ id: 'order-1', orderNumber: 'ORD-1', ...data })) },
    orderOtpLog: { create: jest.fn(async () => ({})) },
    taxConfig: { findMany: jest.fn(async () => TAX_CONFIG_ROWS) },
    productFeeRule: { findMany: jest.fn(async () => []) }, // no fee rules configured by default — resolves to ₹0
    siteSetting: { findUnique: jest.fn(async () => null) },
    commissionRule: { findMany: jest.fn(async () => []) },
  };
  const memberships: any = { getActiveDiscount: jest.fn(async () => 0) };
  const coupons: any = { validate: jest.fn(), recordUsage: jest.fn() };
  const cities: any = { getByName: jest.fn(async () => null), getServicePrice: jest.fn() };
  const payments: any = { initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_1', keyId: 'key_1' })) };
  const svc = new OrdersService(prisma, coupons, memberships, {} as any, {} as any, cities, payments, {} as any, {} as any, {} as any, {} as any);
  const guestSvc = new GuestBookingService(prisma, {} as any, {} as any, payments, cities, {} as any);
  return { svc, guestSvc, prisma };
}

describe('OrdersService.create — Phase 8 product GST + fee resolution', () => {
  it('resolves real per-HSN GST for an EXCLUSIVE product and populates remontCommission/vendorPayout (previously always 0)', async () => {
    const { svc, prisma } = makeService();
    prisma.productFeeRule.findMany.mockImplementation(async ({ where }: any) =>
      where.feeType === 'COMMISSION'
        ? [{ id: 'r1', feeType: 'COMMISSION', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', productId: null, commissionType: 'PERCENTAGE', value: 10, priority: 0, stackable: false }]
        : []
    );
    const dto: any = { type: 'PRODUCT', items: [{ productId: 'excl-product', quantity: 1 }] };
    const order = await svc.create('cust-1', dto);
    expect(Number(order.gstAmount)).toBe(120); // 12% of 1000, not flat 18%
    expect(Number(order.totalAmount)).toBe(1120);
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.remontCommission)).toBe(100); // 10% of 1000 — previously hardcoded 0
    expect(Number(order.vendorPayout)).toBe(900); // 1000 taxable - 100 commission
  });

  it('an INCLUSIVE product\'s total is exactly its listed price — no GST added on top', async () => {
    const { svc, prisma } = makeService();
    const dto: any = { type: 'PRODUCT', items: [{ productId: 'incl-product', quantity: 1 }] };
    const order = await svc.create('cust-1', dto);
    expect(Number(order.totalAmount)).toBe(1180);
    expect(Number(order.gstAmount)).toBe(0);
    expect(Number(order.productsTaxableAmount)).toBe(1000);
  });
});

describe('OrdersService.publicProductCheckout — Phase 8 product GST + fee resolution', () => {
  function baseDto(items: { productId: string; quantity: number }[]) {
    return {
      name: 'Guest Customer', phone: '+919999999999', items,
      fullAddress: '123 MG Road', city: 'Bhopal', paymentMethod: 'COD',
    } as any;
  }

  it('resolves real per-HSN GST for an EXCLUSIVE product and populates remontCommission/vendorPayout (previously always 0)', async () => {
    const { guestSvc, prisma } = makeService();
    prisma.productFeeRule.findMany.mockImplementation(async ({ where }: any) =>
      where.feeType === 'COMMISSION'
        ? [{ id: 'r1', feeType: 'COMMISSION', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', productId: null, commissionType: 'PERCENTAGE', value: 10, priority: 0, stackable: false }]
        : []
    );
    const result = await guestSvc.publicProductCheckout(baseDto([{ productId: 'excl-product', quantity: 1 }]));
    const order = (prisma.order.create as jest.Mock).mock.calls[0][0].data;
    expect(Number(order.gstAmount)).toBe(120);
    expect(Number(order.totalAmount)).toBe(1120);
    expect(result.totalAmount).toBe(1120);
    expect(Number(order.remontCommission)).toBe(100);
    expect(Number(order.vendorPayout)).toBe(900);
  });

  it('an INCLUSIVE product\'s total is exactly its listed price — no GST added on top', async () => {
    const { guestSvc, prisma } = makeService();
    await guestSvc.publicProductCheckout(baseDto([{ productId: 'incl-product', quantity: 1 }]));
    const order = (prisma.order.create as jest.Mock).mock.calls[0][0].data;
    expect(Number(order.totalAmount)).toBe(1180);
    expect(Number(order.gstAmount)).toBe(0);
    expect(Number(order.productsTaxableAmount)).toBe(1000);
  });

  it('a mixed cart (one INCLUSIVE + one EXCLUSIVE product) sums correctly with no double-count', async () => {
    const { guestSvc, prisma } = makeService();
    await guestSvc.publicProductCheckout(baseDto([{ productId: 'excl-product', quantity: 1 }, { productId: 'incl-product', quantity: 1 }]));
    const order = (prisma.order.create as jest.Mock).mock.calls[0][0].data;
    expect(Number(order.gstAmount)).toBe(120); // only the exclusive line's tax is added on top
    expect(Number(order.totalAmount)).toBe(1000 + 120 + 1180); // 2300
    expect(Number(order.productsTaxableAmount)).toBe(2000);
  });
});
