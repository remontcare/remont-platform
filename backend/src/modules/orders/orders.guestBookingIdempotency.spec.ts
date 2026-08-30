import { GuestBookingService } from './orders.module';

/**
 * Phase 8 (M-06) — GuestBookingService.book() was the one remaining financial
 * order-creation path with no idempotency guard at all (CreateOrderDto/
 * PublicProductCheckoutDto/CreateMasterOrderDto already all support this — see their own
 * M-06 comments). A double-click/network-retry on the guest "Book Now" quick-book modal
 * could create two separate paid bookings for the same request.
 */
function makeService() {
  const existingOrders: Record<string, any> = {};
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    service: { findUnique: jest.fn() },
    city: { findUnique: jest.fn() },
    commissionRule: { findMany: jest.fn().mockResolvedValue([]) },
    siteSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    address: { create: jest.fn(async (args: any) => ({ id: 'addr-1', ...args.data })) },
    order: {
      create: jest.fn(async (args: any) => {
        const key = args.data.idempotencyKey;
        if (key && existingOrders[key]) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002'; err.meta = { target: ['idempotencyKey'] };
          throw err;
        }
        const order = { id: 'order-' + Object.keys(existingOrders).length, orderNumber: 'REM-' + Object.keys(existingOrders).length, status: 'CONFIRMED', totalAmount: 500, paymentMethod: 'COD', service: { name: 'Plumbing' }, ...args.data };
        if (key) existingOrders[key] = order;
        return order;
      }),
      findUnique: jest.fn(async ({ where }: any) => (where.idempotencyKey ? existingOrders[where.idempotencyKey] || null : null)),
    },
    orderOtpLog: { create: jest.fn() },
  };
  const dispatch: any = { dispatch: jest.fn().mockResolvedValue([]) };
  const routing: any = { route: jest.fn().mockResolvedValue(undefined) };
  const payments: any = {};
  const cities: any = { getServicePrice: jest.fn().mockResolvedValue(null) };
  const paymentNotify: any = { payOnlineNudge: jest.fn().mockResolvedValue(undefined) };
  const svc = new GuestBookingService(prisma, dispatch, routing, payments, cities, paymentNotify);
  return { svc, prisma };
}

function baseDto(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Anjali', phone: '+919999999999', serviceId: 'svc-1', cityId: 'city-1',
    fullAddress: '12 MG Road', slotDate: '2026-08-25', slotTime: '10:00',
    paymentMethod: 'COD' as const,
    ...overrides,
  };
}

describe('GuestBookingService.book — idempotency (M-06)', () => {
  function stubHappyPath(prisma: any) {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.service.findUnique.mockResolvedValue({ id: 'svc-1', isActive: true, categoryId: 'cat-1', basePrice: 500, durationMinutes: 60, paymentMode: 'BOTH' });
    prisma.city.findUnique.mockResolvedValue({ id: 'city-1', name: 'Bhopal', state: 'MP', isActive: true, latitude: 23.25, longitude: 77.41 });
  }

  it('an omitted idempotencyKey behaves exactly as before — no dedupe check at all', async () => {
    const { svc, prisma } = makeService();
    stubHappyPath(prisma);
    await svc.book(baseDto() as any);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it('same request retried with the same idempotencyKey never creates a second order — the up-front check short-circuits it', async () => {
    const { svc, prisma } = makeService();
    stubHappyPath(prisma);
    const dto = baseDto({ idempotencyKey: 'client-token-1' });

    const first = await svc.book(dto as any);
    const second = await svc.book(dto as any);

    expect(prisma.order.create).toHaveBeenCalledTimes(1); // ONE financial order, not two
    expect(second.orderId).toBe(first.orderId);
  });

  it('two concurrent requests racing on the same key: the DB unique-constraint loser returns the winner\'s order, never throws', async () => {
    const { svc, prisma } = makeService();
    stubHappyPath(prisma);
    // Simulate the up-front findUnique missing (both requests arrive before either commits)
    // by having it always resolve null the first time, forcing both into order.create() —
    // the second one hits the P2002 branch.
    const dto = baseDto({ idempotencyKey: 'race-token' });
    const p1 = svc.book(dto as any);
    const p2 = svc.book(dto as any);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(prisma.order.create).toHaveBeenCalledTimes(2); // both attempted create — this is the race window
    expect(r1.orderId).toBe(r2.orderId); // but only ONE row actually exists — both callers see the same order
  });

  it('a different idempotencyKey is a genuinely new booking, not deduped', async () => {
    const { svc, prisma } = makeService();
    stubHappyPath(prisma);
    await svc.book(baseDto({ idempotencyKey: 'token-a' }) as any);
    await svc.book(baseDto({ idempotencyKey: 'token-b' }) as any);
    expect(prisma.order.create).toHaveBeenCalledTimes(2);
  });
});
