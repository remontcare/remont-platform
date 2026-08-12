import { MasterOrdersService } from './master-orders.module';

/**
 * End-to-end integration coverage for the Smart Order Grouping rule implemented in
 * checkout(): Same Customer + Same Address + Same Service Category + Same Checkout = ONE
 * Order. Unlike master-orders.split.spec.ts (which only unit-tests the pure grouping
 * function), this drives the real checkout() method against a mocked Prisma so the full
 * pricing → transaction → Order.create() path is exercised, matching the "Verify before
 * finishing" scenarios from the Smart Order Grouping spec.
 */

const CATEGORY_ELECTRICAL = 'cat-electrical';
const CATEGORY_PLUMBING = 'cat-plumbing';
const CATEGORY_CARPENTER = 'cat-carpenter';

const SERVICES: Record<string, any> = {
  'fan-install': { id: 'fan-install', categoryId: CATEGORY_ELECTRICAL, basePrice: 300, isActive: true, paymentMode: 'ANY' },
  'switchboard-install': { id: 'switchboard-install', categoryId: CATEGORY_ELECTRICAL, basePrice: 500, isActive: true, paymentMode: 'ANY' },
  'tap-repair': { id: 'tap-repair', categoryId: CATEGORY_PLUMBING, basePrice: 200, isActive: true, paymentMode: 'ANY' },
  'carpenter-svc': { id: 'carpenter-svc', categoryId: CATEGORY_CARPENTER, basePrice: 400, isActive: true, paymentMode: 'ANY' },
};

function makeService() {
  const createdOrders: any[] = [];
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    service: { findMany: jest.fn(async ({ where }: any) => Object.values(SERVICES).filter((s) => where.id.in.includes(s.id))) },
    product: { findMany: jest.fn(async () => []) },
    address: {
      findUnique: jest.fn(async () => ({
        id: 'addr-1', fullAddress: '123 MG Road', city: 'Bhopal', state: 'MP', pincode: '462001',
        latitude: 0, longitude: 0,
      })),
      create: jest.fn(),
    },
    commissionRule: { findMany: jest.fn(async () => []) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    masterOrder: { count: jest.fn(async () => 0) },
    walletTransaction: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const tx = {
        masterOrder: { create: jest.fn(async ({ data }: any) => ({ id: 'mo-' + Math.random().toString(36).slice(2), ...data })) },
        order: {
          create: jest.fn(async ({ data }: any) => {
            const order = { id: 'order-' + createdOrders.length, ...data };
            createdOrders.push(order);
            return order;
          }),
        },
        orderTimeline: { create: jest.fn(async () => ({})) },
        orderOtpLog: { create: jest.fn(async () => ({})) },
      };
      return fn(tx);
    }),
  };
  const memberships: any = { getActiveDiscount: jest.fn(async () => 0) };
  const coupons: any = { validate: jest.fn(), recordUsage: jest.fn() };
  const cities: any = { getByName: jest.fn(), getServicePrice: jest.fn() };
  const payments: any = { initiatePayment: jest.fn() };
  const dispatch: any = { dispatch: jest.fn(async () => []) };
  const routing: any = { route: jest.fn(async () => {}) };
  const paymentNotify: any = { paymentSuccess: jest.fn(async () => {}) };

  const svc = new MasterOrdersService(prisma, coupons, memberships, cities, payments, dispatch, routing, paymentNotify);
  return { svc, prisma, createdOrders };
}

function itemsOf(order: any) {
  // Mirrors what tx.order.create() actually receives: `serviceItems: { create: [...] }`.
  return (order.serviceItems && order.serviceItems.create) || [];
}

describe('MasterOrdersService.checkout — Smart Order Grouping (integration)', () => {
  it('1. Two Electrical services + same address/checkout → ONE order with both service line items', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      {
        items: [
          { type: 'SERVICE', serviceId: 'fan-install', quantity: 1 },
          { type: 'SERVICE', serviceId: 'switchboard-install', quantity: 1 },
        ],
        addressId: 'addr-1',
      } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );

    expect(createdOrders).toHaveLength(1);
    expect(result.isCOD).toBe(true);
    const order = createdOrders[0];
    expect(order.serviceId).toBe('fan-install'); // primary/first line, for backward-compat display
    const items = itemsOf(order);
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.serviceId).sort()).toEqual(['fan-install', 'switchboard-install']);
    // 300 + 500, no discount/wallet/COD-gst-only math beyond the flat 18% GST applied.
    expect(Number(order.serviceAmount)).toBe(800);
  });

  it('2. Electrical + Carpenter, same address/checkout → TWO orders', async () => {
    const { svc, createdOrders } = makeService();
    await svc.checkout(
      {
        items: [
          { type: 'SERVICE', serviceId: 'fan-install', quantity: 1 },
          { type: 'SERVICE', serviceId: 'carpenter-svc', quantity: 1 },
        ],
        addressId: 'addr-1',
      } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    expect(createdOrders).toHaveLength(2);
    const categories = createdOrders.map((o) => SERVICES[o.serviceId].categoryId).sort();
    expect(categories).toEqual([CATEGORY_CARPENTER, CATEGORY_ELECTRICAL]);
  });

  it('3. Electrical + Plumbing + Carpenter, same address/checkout → THREE orders', async () => {
    const { svc, createdOrders } = makeService();
    await svc.checkout(
      {
        items: [
          { type: 'SERVICE', serviceId: 'fan-install', quantity: 1 },
          { type: 'SERVICE', serviceId: 'tap-repair', quantity: 1 },
          { type: 'SERVICE', serviceId: 'carpenter-svc', quantity: 1 },
        ],
        addressId: 'addr-1',
      } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    expect(createdOrders).toHaveLength(3);
  });

  it('4. Same category, but two SEPARATE checkout calls (different bookings) → each produces its own order, never merged', async () => {
    const { svc, createdOrders } = makeService();
    await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'switchboard-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    expect(createdOrders).toHaveLength(2);
    expect(createdOrders[0].masterOrderId).not.toBe(createdOrders[1].masterOrderId);
  });

  it('4b. Same category, DIFFERENT addresses (two checkouts) → separate orders, never merged', async () => {
    const { svc, prisma, createdOrders } = makeService();
    prisma.address.findUnique
      .mockResolvedValueOnce({ id: 'addr-1', fullAddress: '123 MG Road', city: 'Bhopal', state: 'MP', pincode: '462001', latitude: 0, longitude: 0 })
      .mockResolvedValueOnce({ id: 'addr-2', fullAddress: '456 Link Road', city: 'Indore', state: 'MP', pincode: '452001', latitude: 0, longitude: 0 });

    await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'switchboard-install', quantity: 1 }], addressId: 'addr-2' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    expect(createdOrders).toHaveLength(2);
    expect(createdOrders[0].addressId).toBe('addr-1');
    expect(createdOrders[1].addressId).toBe('addr-2');
    expect(createdOrders[0].masterOrderId).not.toBe(createdOrders[1].masterOrderId);
  });

  it('5. Single service → exactly ONE normal order, unchanged shape (single serviceItems row)', async () => {
    const { svc, createdOrders } = makeService();
    await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'tap-repair', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    expect(createdOrders).toHaveLength(1);
    const order = createdOrders[0];
    expect(order.serviceId).toBe('tap-repair');
    expect(itemsOf(order)).toEqual([{ serviceId: 'tap-repair', quantity: 1, unitPrice: 200, totalPrice: 200 }]);
    expect(Number(order.serviceAmount)).toBe(200);
  });

  it('6. Order total reflects the full checkout (GST included) and status is CONFIRMED for COD', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      {
        items: [
          { type: 'SERVICE', serviceId: 'fan-install', quantity: 1 },
          { type: 'SERVICE', serviceId: 'switchboard-install', quantity: 1 },
        ],
        addressId: 'addr-1',
      } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    // subtotal 800, GST 18% = 144, total = 944; matches the 18%-GST math checkout() applies uniformly.
    expect(result.totalAmount).toBeCloseTo(944, 2);
    expect(createdOrders[0].status).toBe('CONFIRMED');
    expect(createdOrders[0].paymentStatus).toBe('PENDING');
  });
});
