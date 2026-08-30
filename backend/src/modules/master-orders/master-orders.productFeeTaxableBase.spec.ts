import { MasterOrdersService } from './master-orders.module';

/**
 * C-01 regression guard — commission/marketing/gateway fees must be computed on the
 * resolved ex-GST taxable value (resolveProductGstLine().taxableValue), never on the gross
 * line total. For a GST-Exclusive line these are numerically identical (no behaviour change
 * there); the bug only ever affected GST-Inclusive lines, where the gross total already has
 * tax baked in that was never the seller's revenue to pay commission against.
 *
 * Every product below is priced so its taxable value is exactly ₹1,000, and a single 10%
 * COMMISSION rule is configured — so every case in the matrix expects exactly ₹100
 * commission. Before the fix, every INCLUSIVE case here would have returned commission
 * computed on the gross (tax-inclusive) price instead.
 */

const CATEGORY = 'cat-1';
const VENDOR = 'seller-a';

const PRODUCTS: Record<string, any> = {
  // A. 18% GST, Inclusive — price ₹1,180, taxable ₹1,000
  'p-18-incl': { id: 'p-18-incl', categoryId: CATEGORY, vendorId: VENDOR, price: 1180, hsnSac: 'HSN-18-INCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // B. 12% GST, Inclusive — price ₹1,120, taxable ₹1,000
  'p-12-incl': { id: 'p-12-incl', categoryId: CATEGORY, vendorId: VENDOR, price: 1120, hsnSac: 'HSN-12-INCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // C. 5% GST, Inclusive — price ₹1,050, taxable ₹1,000
  'p-5-incl': { id: 'p-5-incl', categoryId: CATEGORY, vendorId: VENDOR, price: 1050, hsnSac: 'HSN-5-INCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // D. 18% GST, Exclusive — price ₹1,000, taxable ₹1,000 (control case — already correct pre-fix)
  'p-18-excl': { id: 'p-18-excl', categoryId: CATEGORY, vendorId: VENDOR, price: 1000, hsnSac: 'HSN-18-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // E. Genuine 0% (NIL-rated) — price ₹1,000, taxable ₹1,000
  'p-0-rate': { id: 'p-0-rate', categoryId: CATEGORY, vendorId: VENDOR, price: 1000, hsnSac: 'HSN-0', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // F. GST-exempt (gstApplicable: false, distinct from a genuine 0% rate) — price ₹1,000, taxable ₹1,000
  'p-exempt': { id: 'p-exempt', categoryId: CATEGORY, vendorId: VENDOR, price: 1000, hsnSac: 'HSN-EXEMPT', gstOverridePercent: null, gstInclusive: null, isActive: true },
  // G. Product-level GST override (18%, Inclusive) — no matching TaxConfig row needed, the override wins outright
  'p-override': { id: 'p-override', categoryId: CATEGORY, vendorId: VENDOR, price: 1180, hsnSac: null, gstOverridePercent: 18, gstInclusive: true, isActive: true },
  // H. Category-level default GST (18%, Inclusive) — product has no HSN/override, falls through to the category row
  'p-cat-default': { id: 'p-cat-default', categoryId: CATEGORY, vendorId: VENDOR, price: 1180, hsnSac: null, gstOverridePercent: null, gstInclusive: null, isActive: true },
};

const TAX_CONFIG_ROWS = [
  { rate: 18, hsnCode: 'HSN-18-INCL', productCategoryId: null, appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-01') },
  { rate: 12, hsnCode: 'HSN-12-INCL', productCategoryId: null, appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-02') },
  { rate: 5, hsnCode: 'HSN-5-INCL', productCategoryId: null, appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-03') },
  { rate: 18, hsnCode: 'HSN-18-EXCL', productCategoryId: null, appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-04') },
  { rate: 0, hsnCode: 'HSN-0', productCategoryId: null, appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-05') },
  { rate: 18, hsnCode: 'HSN-EXEMPT', productCategoryId: null, appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: false, isActive: true, createdAt: new Date('2026-01-06') },
  // Category-level default (no hsnCode) — only ever matched by a product with no HSN of its own.
  { rate: 18, hsnCode: null, productCategoryId: CATEGORY, appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-07') },
];

const COMMISSION_RULE = { id: 'r1', feeType: 'COMMISSION', scope: 'PRODUCT_CATEGORY', productCategoryId: CATEGORY, productId: null, commissionType: 'PERCENTAGE', value: 10, priority: 0, stackable: false };

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
    // Only the COMMISSION fee type is under test here — MARKETING/GATEWAY have no rule
    // configured, exactly like production defaults to (resolves to ₹0, not under test).
    productFeeRule: { findMany: jest.fn(async ({ where }: any) => (where.feeType === 'COMMISSION' ? [COMMISSION_RULE] : [])) },
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
  return { svc, createdOrders, createdMasterOrders };
}

function baseDto(items: { productId: string; quantity: number }[]) {
  return { items: items.map((i) => ({ type: 'PRODUCT', ...i })), addressId: 'addr-1', city: 'Bhopal' } as any;
}
const opts = { customerId: 'cust-1', paymentMethod: 'COD' as const };

describe('C-01 — commission is computed on taxable value, not gross price (GST-Inclusive matrix)', () => {
  it('A. 18% Inclusive — price ₹1,180, taxable ₹1,000 → commission ₹100 (was ₹118 before the fix)', async () => {
    const { svc, createdOrders } = makeService(['p-18-incl']);
    await svc.checkout(baseDto([{ productId: 'p-18-incl', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('B. 12% Inclusive — price ₹1,120, taxable ₹1,000 → commission ₹100 (was ₹112 before the fix)', async () => {
    const { svc, createdOrders } = makeService(['p-12-incl']);
    await svc.checkout(baseDto([{ productId: 'p-12-incl', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('C. 5% Inclusive — price ₹1,050, taxable ₹1,000 → commission ₹100 (was ₹105 before the fix)', async () => {
    const { svc, createdOrders } = makeService(['p-5-incl']);
    await svc.checkout(baseDto([{ productId: 'p-5-incl', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('D. GST-Exclusive control case — price ₹1,000, 18% added on top → commission ₹100 (unchanged by the fix, taxable == gross here)', async () => {
    const { svc, createdOrders } = makeService(['p-18-excl']);
    await svc.checkout(baseDto([{ productId: 'p-18-excl', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.gstAmount)).toBe(180); // GST added on top, unaffected by this fix
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('E. Genuine 0% (NIL-rated) — taxable ₹1,000 → commission ₹100', async () => {
    const { svc, createdOrders } = makeService(['p-0-rate']);
    await svc.checkout(baseDto([{ productId: 'p-0-rate', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.gstAmount)).toBe(0);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('F. GST-exempt — taxable ₹1,000 → commission ₹100', async () => {
    const { svc, createdOrders } = makeService(['p-exempt']);
    await svc.checkout(baseDto([{ productId: 'p-exempt', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.gstAmount)).toBe(0);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('G. Product-level GST override (18% Inclusive) — taxable ₹1,000 → commission ₹100', async () => {
    const { svc, createdOrders } = makeService(['p-override']);
    await svc.checkout(baseDto([{ productId: 'p-override', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('H. Category-level default GST (18% Inclusive, no product HSN/override) — taxable ₹1,000 → commission ₹100', async () => {
    const { svc, createdOrders } = makeService(['p-cat-default']);
    await svc.checkout(baseDto([{ productId: 'p-cat-default', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.remontCommission)).toBe(100);
  });

  it('I. Multiple products, different GST rates, same order — each line\'s commission is based on ITS OWN taxable value, summed correctly', async () => {
    const { svc, createdOrders } = makeService(['p-18-incl', 'p-12-incl', 'p-5-incl', 'p-18-excl']);
    await svc.checkout(baseDto([
      { productId: 'p-18-incl', quantity: 1 },
      { productId: 'p-12-incl', quantity: 1 },
      { productId: 'p-5-incl', quantity: 1 },
      { productId: 'p-18-excl', quantity: 1 },
    ]), opts);
    // Same seller/category — Child Order Engine groups all four into one child Order.
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(4000); // 1000 × 4
    expect(Number(order.remontCommission)).toBe(400); // 100 × 4 — was 118+112+105+100=435 before the fix
  });

  it('regression guard: MARKETING/GATEWAY fees (no rule configured) stay ₹0 and are unaffected by the taxable-base fix', async () => {
    const { svc, createdOrders } = makeService(['p-18-incl']);
    await svc.checkout(baseDto([{ productId: 'p-18-incl', quantity: 1 }]), opts);
    const breakdown = createdOrders[0].productFeeBreakdown;
    expect(breakdown.marketing.amount).toBe(0);
    expect(breakdown.gateway.amount).toBe(0);
  });
});
