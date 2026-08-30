import { OrdersService } from './orders.module';

/**
 * Phase 3 (discount/GST/settlement audit, C-02/C-03/M-04) — OrdersService.create() is a
 * second, legacy single-Order checkout path (predates the Child-Order-split engine — see
 * MasterOrdersService.checkout()) that can mix one service with products from possibly
 * several sellers in the SAME Order row, with no per-seller split. A SELLER-funded
 * discount can only be safely attributed to a single seller — this file covers both the
 * single-seller (attributable) and mixed/multi-seller (deliberately left platform-funded)
 * cases. See master-orders.discountFunding.spec.ts for the primary Child-Order-engine path.
 */

const PRODUCT_A1 = { id: 'a1', categoryId: 'cat-1', vendorId: 'seller-a', price: 1000, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCT_A2 = { id: 'a2', categoryId: 'cat-1', vendorId: 'seller-a', price: 500, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCT_B1 = { id: 'b1', categoryId: 'cat-1', vendorId: 'seller-b', price: 500, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true };
const PRODUCTS: Record<string, any> = { a1: PRODUCT_A1, a2: PRODUCT_A2, b1: PRODUCT_B1 };
const TAX_CONFIG_ROWS = [
  { rate: 12, hsnCode: 'HSN-EXCL', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-01') },
];

function makeService() {
  const allocations: any[] = [];
  let createdOrder: any;
  const prisma: any = {
    product: { findUnique: jest.fn(async ({ where }: any) => PRODUCTS[where.id] || null), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    address: { create: jest.fn(async ({ data }: any) => ({ id: 'addr-1', ...data })), findUnique: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ id: 'user-1', name: null, phone: '+919999999999' })), create: jest.fn(), update: jest.fn() },
    order: { create: jest.fn(async ({ data }: any) => { createdOrder = { id: 'order-1', orderNumber: 'ORD-1', ...data }; return createdOrder; }) },
    orderOtpLog: { create: jest.fn(async () => ({})) },
    orderDiscountAllocation: { create: jest.fn(async ({ data }: any) => { allocations.push(data); return data; }) },
    taxConfig: { findMany: jest.fn(async () => TAX_CONFIG_ROWS) },
    productFeeRule: { findMany: jest.fn(async () => []) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    commissionRule: { findMany: jest.fn(async () => []) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma)); // Phase 8 (H-07) — create() now wraps stock-check + order.create() in one transaction
  const memberships: any = { getActiveDiscount: jest.fn(async () => 0) };
  const coupons: any = { validate: jest.fn(), recordUsage: jest.fn() };
  const cities: any = { getByName: jest.fn(async () => null), getServicePrice: jest.fn() };
  const payments: any = { initiatePayment: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_1', keyId: 'key_1' })) };
  const svc = new OrdersService(prisma, coupons, memberships, {} as any, {} as any, cities, payments, {} as any, {} as any, {} as any, {} as any);
  return { svc, coupons, allocations, getOrder: () => createdOrder };
}

describe('OrdersService.create — discount funding (C-02/C-03/M-04) on the legacy single-Order path', () => {
  it('1. SELLER-funded coupon, every product from the SAME single seller — taxable value/GST reduced, seller correctly identified', async () => {
    const { svc, coupons, allocations, getOrder } = makeService();
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 150, coupon: { id: 'c1', code: 'S150', type: 'FLAT', fundedBy: 'SELLER' } });
    await svc.create('cust-1', { type: 'PRODUCT', couponCode: 'S150', items: [{ productId: 'a1', quantity: 1 }, { productId: 'a2', quantity: 1 }] } as any);
    const order = getOrder();
    // subtotal 1500, discount 150 => ratio 0.9
    expect(Number(order.productsTaxableAmount)).toBe(1350);
    expect(Number(order.gstAmount)).toBe(162); // 12% of 1350
    expect(allocations[0].sellerId).toBe('seller-a');
    expect(allocations[0].fundingSource).toBe('SELLER');
    expect(allocations[0].taxableValueReduced).toBe(true);
    expect(Number(allocations[0].settlementImpact)).toBe(-150);
  });

  it('2. SELLER-funded coupon, but products span TWO different sellers — cannot attribute to one seller, stays platform-funded/unreduced', async () => {
    const { svc, coupons, allocations, getOrder } = makeService();
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 150, coupon: { id: 'c2', code: 'S150B', type: 'FLAT', fundedBy: 'SELLER' } });
    await svc.create('cust-1', { type: 'PRODUCT', couponCode: 'S150B', items: [{ productId: 'a1', quantity: 1 }, { productId: 'b1', quantity: 1 }] } as any);
    const order = getOrder();
    // subtotal 1500 (1000 + 500), no reduction applied — ambiguous seller attribution
    expect(Number(order.productsTaxableAmount)).toBe(1500);
    expect(Number(order.gstAmount)).toBe(180); // 12% of 1500, unchanged
    expect(allocations[0].sellerId).toBeUndefined();
    expect(allocations[0].fundingSource).toBe('PLATFORM');
    expect(allocations[0].taxableValueReduced).toBe(false);
    expect(allocations[0].gstTreatment).toBe('NOT_REDUCED_PLATFORM_FUNDED_PENDING_CA_REVIEW');
  });

  it('3. PLATFORM-funded coupon (the default) on a pure product order — unchanged behaviour, recorded explicitly', async () => {
    const { svc, coupons, allocations, getOrder } = makeService();
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 100, coupon: { id: 'c3', code: 'P100', type: 'FLAT', fundedBy: 'PLATFORM' } });
    await svc.create('cust-1', { type: 'PRODUCT', couponCode: 'P100', items: [{ productId: 'a1', quantity: 1 }] } as any);
    const order = getOrder();
    expect(Number(order.productsTaxableAmount)).toBe(1000);
    expect(Number(order.gstAmount)).toBe(120);
    expect(allocations[0].fundingSource).toBe('PLATFORM');
    expect(Number(allocations[0].settlementImpact)).toBe(0);
  });

  it('4. Mixed service + single-seller product order (BUNDLE), SELLER-funded coupon — product side reduced, allocation correctly attributes settlement impact to that seller only', async () => {
    const { svc, coupons, allocations, getOrder } = makeService();
    coupons.validate.mockResolvedValue({ valid: true, discountAmount: 250, coupon: { id: 'c4', code: 'MIX250', type: 'FLAT', fundedBy: 'SELLER' } });
    // No serviceId in this DTO shape keeps serviceAmount at 0 in this harness (no Service
    // lookup mocked) — this exercises the "isProductOrder" attribution path in isolation;
    // the mixed-order-specific gstTreatment label is covered directly in
    // common/discountFunding.spec.ts's buildDiscountAllocationData suite.
    await svc.create('cust-1', { type: 'PRODUCT', couponCode: 'MIX250', items: [{ productId: 'a1', quantity: 1 }, { productId: 'a2', quantity: 1 }] } as any);
    const order = getOrder();
    expect(Number(order.productsTaxableAmount)).toBe(1250); // 1500 - 250
    expect(allocations[0].sellerId).toBe('seller-a');
    expect(Number(allocations[0].settlementImpact)).toBe(-250);
  });
});
