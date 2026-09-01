import { MasterOrdersService } from './master-orders.module';

/**
 * Bundle offer — a customer checking out a SERVICE and a PRODUCT together in the same
 * MasterOrder gets an admin-configurable discount (SiteSetting 'bundle_discount_percent',
 * default 10%) applied to the SERVICE component only; the PRODUCT component is never
 * touched. The affected SERVICE child is also flagged bundleDispatchDeferred so
 * RoutingService.route() is never called for it at checkout/confirm time — only once
 * ShipmentService.onShipmentDelivered() (logistics.module.ts) confirms every sibling
 * PRODUCT child has been delivered.
 */

const SERVICE_ELECTRICAL = { id: 'fan-install', categoryId: 'cat-electrical', basePrice: 1000, isActive: true, paymentMode: 'ANY' };
const PRODUCT_EXCL: Record<string, any> = {
  'excl-product': { id: 'excl-product', categoryId: 'cat-1', vendorId: 'seller-a', price: 1000, hsnSac: 'HSN-EXCL', gstOverridePercent: null, gstInclusive: null, isActive: true },
};
const TAX_CONFIG_ROWS = [
  { rate: 12, hsnCode: 'HSN-EXCL', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', gstApplicable: true, isActive: true, createdAt: new Date('2026-01-01') },
];

function makeService(bundlePercentSetting: string | null = null) {
  const createdOrders: any[] = [];
  const createdMasterOrders: any[] = [];
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    service: { findMany: jest.fn(async () => [SERVICE_ELECTRICAL]) },
    product: { findMany: jest.fn(async (args: any) => Object.values(PRODUCT_EXCL).filter((p) => args.where.id.in.includes(p.id))) },
    address: {
      findUnique: jest.fn(async () => ({ id: 'addr-1', fullAddress: '123 MG Road', city: 'Bhopal', state: 'MP', pincode: '462001', latitude: 0, longitude: 0 })),
      create: jest.fn(),
    },
    commissionRule: { findMany: jest.fn(async () => []) },
    productFeeRule: { findMany: jest.fn(async () => []) },
    taxConfig: { findMany: jest.fn(async () => TAX_CONFIG_ROWS) },
    siteSetting: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.key === 'bundle_discount_percent' && bundlePercentSetting !== null
          ? { key: 'bundle_discount_percent', value: bundlePercentSetting }
          : null,
      ),
    },
    masterOrder: {
      count: jest.fn(async () => 0),
      findUnique: jest.fn(async ({ where }: any) => {
        const mo = where.idempotencyKey
          ? createdMasterOrders.find((m) => m.idempotencyKey === where.idempotencyKey)
          : createdMasterOrders.find((m) => m.id === where.id);
        if (!mo) return null;
        const childOrders = createdOrders.filter((o) => o.masterOrderId === mo.id);
        return { ...mo, childOrders };
      }),
    },
    paymentTransaction: { findFirst: jest.fn(async () => ({ status: 'PAID' })) },
    $transaction: jest.fn(async (fn: any) => {
      const tx = {
        product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        masterOrder: {
          create: jest.fn(async ({ data }: any) => {
            const mo = { id: 'mo-' + (createdMasterOrders.length + 1), ...data };
            createdMasterOrders.push(mo);
            return mo;
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const mo = createdMasterOrders.find((m) => m.id === where.id);
            if (mo) Object.assign(mo, data);
            return mo;
          }),
        },
        order: {
          create: jest.fn(async ({ data }: any) => {
            const order = { id: 'order-' + createdOrders.length, ...data };
            createdOrders.push(order);
            return order;
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const order = createdOrders.find((o) => o.id === where.id);
            if (order) Object.assign(order, data);
            return order;
          }),
        },
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
  return { svc, prisma, createdOrders, createdMasterOrders, routing };
}

const bundleDto = {
  items: [
    { type: 'SERVICE', serviceId: 'fan-install', quantity: 1 },
    { type: 'PRODUCT', productId: 'excl-product', quantity: 1 },
  ],
  addressId: 'addr-1', city: 'Bhopal',
} as any;

describe('MasterOrdersService.checkout — Bundle offer (product + service together)', () => {
  it('applies the default 10% discount to the SERVICE child only when no admin override exists', async () => {
    const { svc, createdOrders } = makeService(null);
    const result = await svc.checkout(bundleDto, { customerId: 'cust-1', paymentMethod: 'COD' });

    const serviceChild = createdOrders.find((o) => o.type === 'SERVICE');
    const productChild = createdOrders.find((o) => o.type === 'PRODUCT');

    expect(Number(serviceChild.bundleDiscountPercent)).toBe(10);
    expect(Number(serviceChild.bundleDiscountAmount)).toBe(100); // 10% of ₹1000 service price
    expect(productChild.bundleDiscountAmount === undefined ? 0 : Number(productChild.bundleDiscountAmount)).toBe(0);
    expect(productChild.bundleDiscountPercent).toBeFalsy();

    // Service: 1000 - 100 bundle discount = 900 taxable, GST 18% = 162 -> total 1062.
    expect(Number(serviceChild.gstAmount)).toBe(162);
    expect(Number(serviceChild.totalAmount)).toBe(1062);
    // Product: untouched — 1000 + 12% GST = 1120.
    expect(Number(productChild.totalAmount)).toBe(1120);
    // Master total is the exact sum of both children — no money lost/gained in the split.
    expect(result.totalAmount).toBeCloseTo(1062 + 1120, 2);
    expect((result as any).isBundleOrder).toBe(true);
    expect((result as any).bundleDiscountPercent).toBe(10);
    expect((result as any).bundleDiscount).toBe(100);
  });

  it('honors an admin-configured percent (15%) from SiteSetting instead of the default', async () => {
    const { svc, createdOrders } = makeService('15');
    await svc.checkout(bundleDto, { customerId: 'cust-1', paymentMethod: 'COD' });
    const serviceChild = createdOrders.find((o) => o.type === 'SERVICE');
    expect(Number(serviceChild.bundleDiscountPercent)).toBe(15);
    expect(Number(serviceChild.bundleDiscountAmount)).toBe(150);
  });

  it('clamps an invalid/out-of-range admin value (e.g. "500") down to 100, never inverting or zeroing the price', async () => {
    const { svc, createdOrders } = makeService('500');
    await svc.checkout(bundleDto, { customerId: 'cust-1', paymentMethod: 'COD' });
    const serviceChild = createdOrders.find((o) => o.type === 'SERVICE');
    expect(Number(serviceChild.bundleDiscountPercent)).toBe(100);
    expect(Number(serviceChild.bundleDiscountAmount)).toBe(1000);
  });

  it('a SERVICE-only cart (no product) gets no bundle discount at all — regression guard', async () => {
    const { svc, createdOrders } = makeService(null);
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    const serviceChild = createdOrders[0];
    expect(Number(serviceChild.bundleDiscountAmount)).toBe(0);
    expect(serviceChild.bundleDiscountPercent).toBeFalsy();
    expect((result as any).isBundleOrder).toBe(false);
    expect(Number(serviceChild.totalAmount)).toBe(1180); // 1000 + 18% GST, unaffected
  });

  it('a PRODUCT-only cart (no service) gets no bundle discount at all — regression guard', async () => {
    const { svc, createdOrders } = makeService(null);
    await svc.checkout(
      { items: [{ type: 'PRODUCT', productId: 'excl-product', quantity: 1 }], addressId: 'addr-1', city: 'Bhopal' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    const productChild = createdOrders[0];
    expect(Number(productChild.bundleDiscountAmount)).toBe(0);
    expect(Number(productChild.totalAmount)).toBe(1120); // unaffected
  });
});

describe('MasterOrdersService — Bundle offer defers service dispatch until product delivery', () => {
  it('COD bundle: routing.route() is NOT called for the bundle service child at checkout time', async () => {
    const { svc, createdOrders, routing } = makeService(null);
    await svc.checkout(bundleDto, { customerId: 'cust-1', paymentMethod: 'COD' });
    const serviceChild = createdOrders.find((o) => o.type === 'SERVICE');
    expect(serviceChild.bundleDispatchDeferred).toBe(true);
    expect(routing.route).not.toHaveBeenCalledWith(serviceChild.id);
  });

  it('ONLINE bundle: routing.route() is NOT called for the bundle service child even after confirmPayment()', async () => {
    const { svc, createdOrders, routing } = makeService(null);
    const result = await svc.checkout(bundleDto, { customerId: 'cust-1', paymentMethod: 'ONLINE' });
    await svc.confirmPayment(result.masterOrderId, 'pay_1');
    const serviceChild = createdOrders.find((o) => o.type === 'SERVICE');
    expect(serviceChild.status).toBe('CONFIRMED'); // payment cascade still applies normally
    expect(routing.route).not.toHaveBeenCalledWith(serviceChild.id);
  });

  it('a plain (non-bundle) SERVICE order still routes immediately — unaffected by this feature', async () => {
    const { svc, createdOrders, routing } = makeService(null);
    await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    const serviceChild = createdOrders[0];
    expect(serviceChild.bundleDispatchDeferred).toBe(false);
    expect(routing.route).toHaveBeenCalledWith(serviceChild.id);
  });
});
