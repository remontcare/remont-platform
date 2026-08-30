import { MasterOrdersService } from './master-orders.module';
import { ProductLedgerService } from '../product-ledger/product-ledger.module';

/**
 * Phase 3 (discount/GST/settlement audit, C-02/C-03/M-04) — targeted coverage for
 * checkout()'s discount-funding path: a PLATFORM-funded coupon (the default) must leave
 * every PRODUCT group's GST/taxable value/seller-settlement exactly as before (today's
 * unchanged behaviour); a SELLER-funded coupon must actually reduce them, consistently,
 * so "what the customer paid" / "what GST was charged on" / "what the seller is settled
 * against" never disagree again. See common/discountFunding.spec.ts for the underlying
 * pure-function unit tests.
 */

const PRODUCT_EXCL_A = { id: 'excl-a', categoryId: 'cat-1', vendorId: 'seller-a', price: 1000, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCT_INCL_A = { id: 'incl-a', categoryId: 'cat-1', vendorId: 'seller-a', price: 1180, hsnSac: 'HSN-INCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCT_EXCL_B = { id: 'excl-b', categoryId: 'cat-2', vendorId: 'seller-b', price: 1000, hsnSac: 'HSN-EXCL-28', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCTS: Record<string, any> = { 'excl-a': PRODUCT_EXCL_A, 'incl-a': PRODUCT_INCL_A, 'excl-b': PRODUCT_EXCL_B };

const TAX_CONFIG_ROWS = [
  { rate: 12, hsnCode: 'HSN-EXCL', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-01') },
  { rate: 18, hsnCode: 'HSN-INCL', appliesTo: ['PRODUCT'], priceType: 'GST_INCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-02') },
  { rate: 28, hsnCode: 'HSN-EXCL-28', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-03') },
];

function makeService(productIds: string[]) {
  const createdOrders: any[] = [];
  const createdMasterOrders: any[] = [];
  const allocations: any[] = [];
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    service: { findMany: jest.fn(async () => []) },
    product: { findMany: jest.fn(async () => productIds.map((id) => PRODUCTS[id])) },
    address: {
      findUnique: jest.fn(async () => ({ id: 'addr-1', fullAddress: '123 MG Road', city: 'Bhopal', state: 'MP', pincode: '462001', latitude: 0, longitude: 0 })),
      create: jest.fn(),
    },
    commissionRule: { findMany: jest.fn(async () => []) },
    productFeeRule: { findMany: jest.fn(async () => []) }, // no fee rules — commission/marketing/gateway are ₹0, isolating the discount/GST math under test
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
        orderDiscountAllocation: { create: jest.fn(async ({ data }: any) => { allocations.push(data); return data; }) },
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
  return { svc, prisma, coupons, createdOrders, createdMasterOrders, allocations };
}

function baseDto(items: { productId: string; quantity: number }[], couponCode?: string) {
  return { items: items.map((i) => ({ type: 'PRODUCT', ...i })), addressId: 'addr-1', city: 'Bhopal', couponCode } as any;
}
const opts = { customerId: 'cust-1', paymentMethod: 'COD' as const };

describe('MasterOrdersService.checkout — discount funding (C-02/C-03/M-04)', () => {
  it('1. No discount at all — allocation row is still written, marked NOT_APPLICABLE, GST/taxable value untouched', async () => {
    const { svc, createdOrders, allocations } = makeService(['excl-a']);
    await svc.checkout(baseDto([{ productId: 'excl-a', quantity: 1 }]), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.gstAmount)).toBe(120);
    expect(allocations[0].gstTreatment).toBe('NOT_APPLICABLE_NO_DISCOUNT');
    expect(allocations[0].fundingSource).toBe('PLATFORM');
  });

  it('2. PLATFORM-funded coupon (the default) on a PRODUCT order — GST/taxable value stay pinned to the pre-discount amount; platform silently bore this before, now it is at least recorded', async () => {
    const { svc, coupons, createdOrders, allocations } = makeService(['excl-a']);
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 100, coupon: { id: 'c1', code: 'SAVE100', type: 'FLAT', fundedBy: 'PLATFORM' } });
    await svc.checkout(baseDto([{ productId: 'excl-a', quantity: 1 }], 'SAVE100'), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(1000); // unchanged — pre-discount
    expect(Number(order.gstAmount)).toBe(120); // unchanged — pre-discount
    expect(Number(order.couponDiscount)).toBe(100); // still charged less...
    expect(Number(order.totalAmount)).toBe(1000 - 100 + 120); // ...discount comes off post-GST, exactly as before
    const alloc = allocations[0];
    expect(alloc.fundingSource).toBe('PLATFORM');
    expect(alloc.taxableValueReduced).toBe(false);
    expect(alloc.gstTreatment).toBe('NOT_REDUCED_PLATFORM_FUNDED_PENDING_CA_REVIEW');
    expect(alloc.accountingTreatment).toBe('PLATFORM_MARKETING_EXPENSE');
    expect(Number(alloc.settlementImpact)).toBe(0); // seller settlement must NOT be touched for a platform-funded discount
  });

  it('3. SELLER-funded coupon on a single-seller GST-EXCLUSIVE PRODUCT order — taxable value/GST correctly reduced, and the reduction flows straight into settlement (C-02 + C-03 together)', async () => {
    const { svc, coupons, createdOrders, allocations } = makeService(['excl-a']);
    // 1000 taxable, 10% flat-equivalent discount of 100 => ratio 0.9
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 100, coupon: { id: 'c2', code: 'SELLER100', type: 'FLAT', fundedBy: 'SELLER' } });
    await svc.checkout(baseDto([{ productId: 'excl-a', quantity: 1 }], 'SELLER100'), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(900); // 1000 * 0.9
    expect(Number(order.gstAmount)).toBe(108); // 120 * 0.9 — same 12% rate preserved
    expect(Number(order.items.create[0].taxableValue)).toBe(900);
    expect(Number(order.items.create[0].gstAmount)).toBe(108);
    // What the customer actually pays: (900 discounted-taxable + 108 gst) ... but the
    // discount itself was already folded into taxable value, so it's not subtracted again.
    expect(Number(order.totalAmount)).toBe(900 + 108);

    const alloc = allocations[0];
    expect(alloc.sellerId).toBe('seller-a');
    expect(alloc.fundingSource).toBe('SELLER');
    expect(alloc.taxableValueReduced).toBe(true);
    expect(Number(alloc.taxableValueAdjustment)).toBe(100); // 1000 - 900
    expect(Number(alloc.settlementImpact)).toBe(-100);
    expect(alloc.gstTreatment).toBe('TAXABLE_VALUE_REDUCED_SELLER_FUNDED');
    expect(alloc.accountingTreatment).toBe('SELLER_BORNE_PRICE_REDUCTION');

    // C-03 — ProductLedgerService reads order.productsTaxableAmount directly; feeding this
    // exact order object through settlement proves the seller is credited GROSS_SALE
    // against the DISCOUNTED base, with zero changes needed in ProductLedgerService itself.
    const ledger = new ProductLedgerService({
      siteSetting: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      taxConfig: { findFirst: jest.fn().mockResolvedValue(null) }, // no TCS rate configured (Phase 7) — unaffected by this Phase 3 test
    } as any);
    const tx: any = {
      $queryRaw: jest.fn(),
      productVendorLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async (a: any) => a.data) },
      productVendorHold: { create: jest.fn(async (a: any) => a.data) },
      productVendor: { update: jest.fn() },
      order: { update: jest.fn() },
    };
    await ledger.settleProductOrder(
      tx,
      { id: order.id, productsAmount: 1000, productsTaxableAmount: order.productsTaxableAmount, productFeeBreakdown: order.productFeeBreakdown, items: [{ vendorId: 'seller-a', product: { returnWindowDays: 7 } }] } as any,
      { logisticsProviderId: null, actualDeliveryCost: 0, deliveredAt: null } as any,
      new Date('2026-08-30T00:00:00Z'),
    );
    const grossSaleCall = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'GROSS_SALE');
    expect(grossSaleCall[0].data.amount).toBe(900); // discounted, not 1000 — the seller settlement bears the discount it funded
  });

  it('4. SELLER-funded coupon on a GST-INCLUSIVE PRODUCT — scaling matches re-resolving GST on the discounted gross exactly', async () => {
    const { svc, coupons, createdOrders } = makeService(['incl-a']);
    // 1180 inclusive @ 18%, discount 236 (20% of 1180) => ratio 0.8
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 236, coupon: { id: 'c3', code: 'BIG20', type: 'FLAT', fundedBy: 'SELLER' } });
    await svc.checkout(baseDto([{ productId: 'incl-a', quantity: 1 }], 'BIG20'), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(800); // 1000 * 0.8
    expect(Number(order.items.create[0].gstAmount)).toBe(144); // 180 * 0.8
    expect(Number(order.gstAmount)).toBe(0); // inclusive line never adds GST on top regardless
  });

  it('5. Multi-seller cart, SELLER-funded coupon, mixed GST rates (12% vs 28%) — each seller\'s own group is scaled independently by its own discount share, never one blended rate', async () => {
    const { svc, coupons, createdOrders, allocations } = makeService(['excl-a', 'excl-b']);
    // subtotal = 2000, coupon discount = 200 (10% of combined) => each 1000 group absorbs 100 (its proportional share)
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 200, coupon: { id: 'c4', code: 'MULTI200', type: 'FLAT', fundedBy: 'SELLER' } });
    await svc.checkout(baseDto([{ productId: 'excl-a', quantity: 1 }, { productId: 'excl-b', quantity: 1 }], 'MULTI200'), opts);

    const orderA = createdOrders.find((o: any) => o.items.create[0].vendorId === 'seller-a');
    const orderB = createdOrders.find((o: any) => o.items.create[0].vendorId === 'seller-b');
    // seller-a: 12% rate, seller-b: 28% rate — each keeps its OWN rate, scaled only by ITS
    // OWN discount share, never a single blended rate across the two.
    expect(Number(orderA.productsTaxableAmount)).toBe(900); // 1000 - 100 share
    expect(Number(orderA.gstAmount)).toBe(108); // 12% of 900
    expect(Number(orderB.productsTaxableAmount)).toBe(900); // 1000 - 100 share
    expect(Number(orderB.gstAmount)).toBe(252); // 28% of 900 — not the same absolute GST as A, correctly rate-specific

    const allocA = allocations.find((a: any) => a.sellerId === 'seller-a');
    const allocB = allocations.find((a: any) => a.sellerId === 'seller-b');
    expect(Number(allocA.taxableValueAdjustment)).toBe(100);
    expect(Number(allocB.taxableValueAdjustment)).toBe(100);
  });

  it('6. A PLATFORM-funded coupon with a multi-seller cart never touches either seller\'s taxable value (no attribution ambiguity — it simply never applies)', async () => {
    const { svc, coupons, createdOrders } = makeService(['excl-a', 'excl-b']);
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 200, coupon: { id: 'c5', code: 'PLAT200', type: 'FLAT', fundedBy: 'PLATFORM' } });
    await svc.checkout(baseDto([{ productId: 'excl-a', quantity: 1 }, { productId: 'excl-b', quantity: 1 }], 'PLAT200'), opts);
    for (const order of createdOrders) {
      const expectedTaxable = order.items.create[0].vendorId === 'seller-a' ? 1000 : 1000;
      expect(Number(order.productsTaxableAmount)).toBe(expectedTaxable);
    }
  });

  it('7. Full-value discount (100% off) on a SELLER-funded order — ratio floors at 0, never goes negative', async () => {
    const { svc, coupons, createdOrders, allocations } = makeService(['excl-a']);
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 1000, coupon: { id: 'c6', code: 'FREE', type: 'FLAT', fundedBy: 'SELLER' } });
    await svc.checkout(baseDto([{ productId: 'excl-a', quantity: 1 }], 'FREE'), opts);
    const order = createdOrders[0];
    expect(Number(order.productsTaxableAmount)).toBe(0);
    expect(Number(order.gstAmount)).toBe(0);
    expect(Number(allocations[0].taxableValueAdjustment)).toBe(1000);
  });
});
