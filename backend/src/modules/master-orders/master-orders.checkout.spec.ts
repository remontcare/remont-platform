import { BadRequestException } from '@nestjs/common';
import { MasterOrdersService } from './master-orders.module';

/**
 * End-to-end integration coverage for the Smart Order Grouping rule implemented in
 * checkout(): Same Customer + Same Address + Same Service Category + Same Checkout = ONE
 * Order. Unlike master-orders.split.spec.ts (which only unit-tests the pure grouping
 * function), this drives the real checkout() method against a mocked Prisma so the full
 * pricing → transaction → Order.create() path is exercised, matching the "Verify before
 * finishing" scenarios from the Smart Order Grouping spec. Also covers the Payment Mode
 * business rules (ANY/ONLINE_ONLY/COD_ONLY) end-to-end, since they're enforced in this same
 * checkout()/confirmPayment()/retryPayment()/switchToCod() surface.
 */

const CATEGORY_ELECTRICAL = 'cat-electrical';
const CATEGORY_PLUMBING = 'cat-plumbing';
const CATEGORY_CARPENTER = 'cat-carpenter';
const CATEGORY_AC = 'cat-ac';
const CATEGORY_HANDYMAN = 'cat-handyman';

const SERVICES: Record<string, any> = {
  'fan-install': { id: 'fan-install', categoryId: CATEGORY_ELECTRICAL, basePrice: 300, isActive: true, paymentMode: 'ANY' },
  'switchboard-install': { id: 'switchboard-install', categoryId: CATEGORY_ELECTRICAL, basePrice: 500, isActive: true, paymentMode: 'ANY' },
  'tap-repair': { id: 'tap-repair', categoryId: CATEGORY_PLUMBING, basePrice: 200, isActive: true, paymentMode: 'ANY' },
  'carpenter-svc': { id: 'carpenter-svc', categoryId: CATEGORY_CARPENTER, basePrice: 400, isActive: true, paymentMode: 'ANY' },
  'svc-online-only': { id: 'svc-online-only', categoryId: CATEGORY_AC, basePrice: 1000, isActive: true, paymentMode: 'ONLINE_ONLY' },
  'svc-cod-only': { id: 'svc-cod-only', categoryId: CATEGORY_HANDYMAN, basePrice: 250, isActive: true, paymentMode: 'COD_ONLY' },
};

function makeService() {
  const createdOrders: any[] = [];
  const createdMasterOrders: any[] = [];
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
    masterOrder: {
      count: jest.fn(async () => 0),
      // Backed by the same createdMasterOrders/createdOrders arrays the $transaction mock
      // below writes to, so confirmPayment()/retryPayment()/switchToCod() (called AFTER
      // checkout() in a test) see the real, current state — including whatever the
      // transaction below has already mutated in place.
      findUnique: jest.fn(async ({ where }: any) => {
        const mo = createdMasterOrders.find((m) => m.id === where.id);
        if (!mo) return null;
        // Mirrors what a real `include: { childOrders: { include: { service: true } } }`
        // query would return — switchToCod() reads c.service off each child, so the mock
        // must actually resolve that relation, not just hand back the raw stored row.
        const childOrders = createdOrders
          .filter((o) => o.masterOrderId === mo.id)
          .map((o) => ({ ...o, service: o.serviceId ? SERVICES[o.serviceId] || null : null }));
        return { ...mo, childOrders };
      }),
    },
    paymentTransaction: { findFirst: jest.fn(async () => ({ status: 'PAID' })) },
    walletTransaction: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const tx = {
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

  const svc = new MasterOrdersService(prisma, coupons, memberships, cities, payments, dispatch, routing, paymentNotify);
  return { svc, prisma, createdOrders, createdMasterOrders, payments, routing, dispatch };
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

describe('MasterOrdersService — Payment Mode business rules (ANY / ONLINE_ONLY / COD_ONLY)', () => {
  it('1. ONLINE_AND_COD service + Online payment succeeds → order confirmed', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    expect(result.requiresPayment).toBe(true);
    expect(createdOrders[0].status).toBe('PENDING_PAYMENT');
    expect(createdOrders[0].paymentStatus).toBe('PENDING');

    await svc.confirmPayment(result.masterOrderId, 'pay_1');
    expect(createdOrders[0].status).toBe('CONFIRMED');
    expect(createdOrders[0].paymentStatus).toBe('PAID');
  });

  it('2. ONLINE_AND_COD service + Online payment fails/abandoned → order stays PENDING_PAYMENT, never silently confirmed', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    // The gateway payment failed — confirmPayment() is never called. Nothing else in this
    // flow ever flips status/paymentStatus on its own.
    expect(result.requiresPayment).toBe(true);
    expect(createdOrders[0].status).toBe('PENDING_PAYMENT');
    expect(createdOrders[0].paymentStatus).toBe('PENDING');
  });

  it('3. ONLINE_AND_COD service + Online failure → switchToCod places the order as Cash on Delivery', async () => {
    const { svc, prisma, createdOrders, routing } = makeService();
    prisma.user.findUnique.mockResolvedValue({ phone: '9999999999' });
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    expect(createdOrders[0].status).toBe('PENDING_PAYMENT');

    await svc.switchToCod(result.masterOrderId, '9999999999');
    expect(createdOrders[0].status).toBe('CONFIRMED');
    expect(createdOrders[0].paymentMethod).toBe('COD');
    expect(routing.route).toHaveBeenCalledWith(createdOrders[0].id);
  });

  it('4. ONLINE_ONLY service — checkout forces Online, success confirms the order', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'svc-online-only', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    expect(result.requiresPayment).toBe(true);
    await svc.confirmPayment(result.masterOrderId, 'pay_2');
    expect(createdOrders[0].status).toBe('CONFIRMED');
    expect(createdOrders[0].paymentStatus).toBe('PAID');
  });

  it('5. ONLINE_ONLY service + Online failure → order stays unconfirmed (no silent confirm, no silent COD)', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'svc-online-only', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    expect(result.requiresPayment).toBe(true);
    expect(createdOrders[0].status).toBe('PENDING_PAYMENT');
    expect(createdOrders[0].paymentStatus).toBe('PENDING');
  });

  it('6. ONLINE_ONLY service — checkout rejects COD outright (COD is never shown/available)', async () => {
    const { svc, createdOrders } = makeService();
    await expect(svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'svc-online-only', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    )).rejects.toThrow(BadRequestException);
    expect(createdOrders).toHaveLength(0); // rejected before any order is created
  });

  it('6b. ONLINE_ONLY service — switchToCod is rejected even for an order that legitimately started Online (defense in depth against a stale client)', async () => {
    const { svc, prisma, createdOrders } = makeService();
    prisma.user.findUnique.mockResolvedValue({ phone: '9999999999' });
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'svc-online-only', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    await expect(svc.switchToCod(result.masterOrderId, '9999999999')).rejects.toThrow(BadRequestException);
    expect(createdOrders[0].status).toBe('PENDING_PAYMENT'); // untouched by the rejected attempt
  });

  it('7. COD_ONLY service — checkout with COD succeeds and confirms immediately', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'svc-cod-only', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'COD' },
    );
    expect(result.isCOD).toBe(true);
    expect(createdOrders[0].status).toBe('CONFIRMED');
    expect(createdOrders[0].paymentStatus).toBe('PENDING'); // COD collected later, at the door
  });

  it('7b. COD_ONLY service — checkout rejects Online outright (no online option shown/available)', async () => {
    const { svc, createdOrders } = makeService();
    await expect(svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'svc-cod-only', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    )).rejects.toThrow(BadRequestException);
    expect(createdOrders).toHaveLength(0);
  });

  it('rejects a cart mixing an ONLINE_ONLY and a COD_ONLY service — no single payment method can satisfy both', async () => {
    const { svc } = makeService();
    const mixedItems = [
      { type: 'SERVICE', serviceId: 'svc-online-only', quantity: 1 },
      { type: 'SERVICE', serviceId: 'svc-cod-only', quantity: 1 },
    ];
    await expect(svc.checkout({ items: mixedItems, addressId: 'addr-1' } as any, { customerId: 'cust-1', paymentMethod: 'ONLINE' }))
      .rejects.toThrow(BadRequestException);
    await expect(svc.checkout({ items: mixedItems, addressId: 'addr-1' } as any, { customerId: 'cust-1', paymentMethod: 'COD' }))
      .rejects.toThrow(BadRequestException);
  });

  it('8. Double-tap "Pay Online" (retryPayment) never creates a duplicate order — only re-initiates the gateway payment', async () => {
    const { svc, prisma, createdOrders, payments } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    expect(createdOrders).toHaveLength(1);
    prisma.user.findUnique.mockResolvedValue({ phone: '9999999999' });

    await svc.retryPayment(result.masterOrderId, '9999999999');
    await svc.retryPayment(result.masterOrderId, '9999999999');

    expect(createdOrders).toHaveLength(1); // still just the one order created at checkout()
    expect(payments.initiatePayment).toHaveBeenCalledTimes(3); // 1 at checkout + 2 retries
  });

  it('9. Repeated confirm-payment calls (webhook retry / duplicate client confirm) stay idempotent — never a duplicate order, never a double status flip', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      { items: [{ type: 'SERVICE', serviceId: 'fan-install', quantity: 1 }], addressId: 'addr-1' } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );

    await svc.confirmPayment(result.masterOrderId, 'pay_1');
    await svc.confirmPayment(result.masterOrderId, 'pay_1'); // duplicate webhook delivery
    await svc.confirmPayment(result.masterOrderId, 'pay_1'); // duplicate again

    expect(createdOrders).toHaveLength(1);
    expect(createdOrders[0].status).toBe('CONFIRMED');
    expect(createdOrders[0].paymentStatus).toBe('PAID');
  });

  it('10. Grouped multi-service order — status/paymentStatus stay consistent across the master AND every child after confirm', async () => {
    const { svc, createdOrders } = makeService();
    const result = await svc.checkout(
      {
        items: [
          { type: 'SERVICE', serviceId: 'fan-install', quantity: 1 },
          { type: 'SERVICE', serviceId: 'carpenter-svc', quantity: 1 },
        ],
        addressId: 'addr-1',
      } as any,
      { customerId: 'cust-1', paymentMethod: 'ONLINE' },
    );
    expect(createdOrders).toHaveLength(2); // Electrical + Carpenter = 2 child orders under 1 master
    createdOrders.forEach((o) => { expect(o.status).toBe('PENDING_PAYMENT'); expect(o.paymentStatus).toBe('PENDING'); });

    await svc.confirmPayment(result.masterOrderId, 'pay_1');
    createdOrders.forEach((o) => { expect(o.status).toBe('CONFIRMED'); expect(o.paymentStatus).toBe('PAID'); });
  });
});
