import { MasterOrdersService } from './master-orders.module';

/**
 * Phase 8 — checkout() must resolve each PRODUCT item's real GST (via TaxConfig/HSN/
 * gstOverridePercent/gstInclusive) instead of the old hardcoded flat 18% on the whole
 * cart. Also covers the Phase-7 fee-resolution path (ProductFeeRule) already wired into
 * this same PRODUCT branch, so a full checkout() run exercises both together.
 */

const PRODUCTS: Record<string, any> = {
  // 12%-taxed, price EXCLUSIVE of GST — the old flat-18% bug would have added 18% here.
  'excl-product': { id: 'excl-product', categoryId: 'cat-1', vendorId: 'seller-a', price: 1000, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // 18%-taxed, price INCLUSIVE of GST — ₹1,180 already contains ₹1,000 taxable + ₹180 GST.
  'incl-product': { id: 'incl-product', categoryId: 'cat-1', vendorId: 'seller-a', price: 1180, hsnSac: 'HSN-INCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
};

const TAX_CONFIG_ROWS = [
  { rate: 12, hsnCode: 'HSN-EXCL', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-01') },
  { rate: 18, hsnCode: 'HSN-INCL', appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-02') },
];

function makeService(productIds: string[]) {
  const createdOrders: any[] = [];
  const createdMasterOrders: any[] = [];
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    service: { findMany: jest.fn(async () => []) },
    product: { findMany: jest.fn(async () => productIds.map((id) => PRODUCTS[id])) },
    address: {
      findUnique: jest.fn(async () => ({ id: 'addr-1', fullAddress: '123 MG Road', city: 'Bhopal', state: 'MP', pincode: '462001', latitude: 0, longitude: 0 })),
      create: jest.fn(),
    },
    commissionRule: { findMany: jest.fn(async () => []) },
    productFeeRule: { findMany: jest.fn(async () => []) }, // no fee rules configured — resolves to ₹0, not under test here
    taxConfig: { findMany: jest.fn(async () => TAX_CONFIG_ROWS) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    masterOrder: { count: jest.fn(async () => 0), findUnique: jest.fn() },
    paymentTransaction: { findFirst: jest.fn(async () => ({ status: 'PAID' })) },
    $transaction: jest.fn(async (fn: any) => {
      const tx = {
        product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }, // Phase 8 (H-07) stock check — always succeeds by default
        masterOrder: { create: jest.fn(async ({ data }: any) => { const mo = { id: 'mo-1', ...data }; createdMasterOrders.push(mo); return mo; }) },
        order: { create: jest.fn(async ({ data }: any) => { const o = { id: 'order-' + createdOrders.length, ...data }; createdOrders.push(o); return o; }) },
        orderTimeline: { create: jest.fn(async () => ({})) },
        orderOtpLog: { create: jest.fn(async () => ({})) },
        orderDiscountAllocation: { create: jest.fn(async () => ({})) },
      };
      return fn(tx);
    }),
  };
  const memberships: any = { getActiveDiscount: jest.fn(async () => 0) };
  const coupons: any = { validate: jest.fn(), recordUsage: jest.fn() };
  const cities: any = { getByName: jest.fn(), getServicePrice: jest.fn() };
  const payments: any = { initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_order_1', keyId: 'rzp_test_key', txId: 'tx-1' })) };
  const dispatch: any = { dispatch: jest.fn(async () => []) };
  const routing: any = { route: jest.fn(async () => {}) };
  const paymentNotify: any = { paymentSuccess: jest.fn(async () => {}) };
  const shipments: any = { createShipmentForOrder: jest.fn(async () => {}) };
  const logistics: any = { checkEligibility: jest.fn(async () => ({ tier: 'STANDARD', charge: 0 })) };

  const svc = new MasterOrdersService(prisma, coupons, memberships, cities, payments, dispatch, routing, paymentNotify, shipments, logistics);
  return { svc, prisma, createdOrders, createdMasterOrders };
}

function baseDto(items: { productId: string; quantity: number }[]) {
  return { items: items.map((i) => ({ type: 'PRODUCT', ...i })), addressId: 'addr-1', city: 'Bhopal' } as any;
}
const opts = { customerId: 'cust-1', paymentMethod: 'COD' as const };

describe('MasterOrdersService.checkout — Phase 8 GST resolution', () => {
  it('an EXCLUSIVE product gets its real per-HSN GST (12%) added on top, not the old flat 18%', async () => {
    const { svc, createdOrders } = makeService(['excl-product']);
    await svc.checkout(baseDto([{ productId: 'excl-product', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.gstAmount)).toBe(120); // 12% of 1000, not 18%
    expect(Number(order.totalAmount)).toBe(1120); // 1000 + 120
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    const item = order.items.create[0];
    expect(item.gstInclusive).toBe(false);
    expect(Number(item.gstRatePercent)).toBe(12);
    expect(Number(item.taxableValue)).toBe(1000);
    expect(Number(item.gstAmount)).toBe(120);
  });

  it('an INCLUSIVE product\'s total is exactly its listed price — GST is never added a second time on top', async () => {
    const { svc, createdOrders } = makeService(['incl-product']);
    await svc.checkout(baseDto([{ productId: 'incl-product', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.totalAmount)).toBe(1180); // the listed price, unchanged — no GST layered on top
    expect(Number(order.gstAmount)).toBe(0); // nothing added on top; the 180 is embedded, not additional
    expect(Number(order.productsTaxableAmount)).toBe(1000); // back-derived ex-GST base
    const item = order.items.create[0];
    expect(item.gstInclusive).toBe(true);
    expect(Number(item.gstRatePercent)).toBe(18);
    expect(Number(item.taxableValue)).toBe(1000);
    expect(Number(item.gstAmount)).toBe(180);
  });

  it('a mixed cart (one INCLUSIVE + one EXCLUSIVE product from the same seller) sums correctly with no double-count', async () => {
    const { svc, createdOrders } = makeService(['excl-product', 'incl-product']);
    await svc.checkout(baseDto([{ productId: 'excl-product', quantity: 1 }, { productId: 'incl-product', quantity: 1 }]), opts);
    // Same seller/category — Child Order Engine groups both into one child Order.
    const order = createdOrders[0];
    // Exclusive line: 1000 + 120 GST added on top. Inclusive line: 1180 flat, no addition.
    expect(Number(order.gstAmount)).toBe(120);
    expect(Number(order.totalAmount)).toBe(1000 + 120 + 1180); // 2300
    expect(Number(order.productsTaxableAmount)).toBe(2000); // 1000 (exclusive) + 1000 (inclusive back-derived)
    expect(order.items.create).toHaveLength(2);
  });
});
