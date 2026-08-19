import { GuestBookingService } from './orders.module';

/**
 * Full lifecycle audit finding: the guest single-service booking flow (the highest-traffic
 * booking path on the site — "Book Now" quick-book modal) always created its Address with
 * the CITY's centroid coordinates, even though the frontend had already captured the
 * customer's real GPS fix for a proximity sanity check a few lines earlier — it just never
 * threaded those coordinates through to the booking payload. This meant every guest single-
 * service order dispatched off city-level precision instead of the actual customer location,
 * unlike the master-order guest checkout path (which already threads real GPS when supplied).
 * Fixed on both sides: GuestBookingDto now accepts optional latitude/longitude (bounds-checked
 * with the same isValidIndiaCoords helper every other location write path uses), and the
 * frontend now sends the already-captured savedAddr.latitude/longitude.
 */
function makeService() {
  const prisma: any = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    service: { findUnique: jest.fn() },
    city: { findUnique: jest.fn() },
    commissionRule: { findMany: jest.fn().mockResolvedValue([]) },
    siteSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    address: { create: jest.fn(async (args: any) => ({ id: 'addr-1', ...args.data })) },
    order: { create: jest.fn(async (args: any) => ({ id: 'order-1', orderNumber: 'REM-1', status: 'CONFIRMED', totalAmount: 500, service: { name: 'Plumbing' }, ...args.data })) },
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

describe('GuestBookingService.book — real GPS vs city-centroid fallback', () => {
  it('uses the city centroid when no coordinates are supplied (unchanged pre-existing behavior)', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.service.findUnique.mockResolvedValue({ id: 'svc-1', isActive: true, categoryId: 'cat-1', basePrice: 500, durationMinutes: 60, paymentMode: 'BOTH' });
    prisma.city.findUnique.mockResolvedValue({ id: 'city-1', name: 'Bhopal', state: 'MP', isActive: true, latitude: 23.25, longitude: 77.41 });

    await svc.book(baseDto() as any);

    expect(prisma.address.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ latitude: 23.25, longitude: 77.41 }),
    }));
  });

  it('prefers the customer-supplied real GPS fix over the city centroid when valid', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.service.findUnique.mockResolvedValue({ id: 'svc-1', isActive: true, categoryId: 'cat-1', basePrice: 500, durationMinutes: 60, paymentMode: 'BOTH' });
    prisma.city.findUnique.mockResolvedValue({ id: 'city-1', name: 'Bhopal', state: 'MP', isActive: true, latitude: 23.25, longitude: 77.41 });

    await svc.book(baseDto({ latitude: 23.2011, longitude: 77.4396 }) as any);

    expect(prisma.address.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ latitude: 23.2011, longitude: 77.4396 }),
    }));
  });

  it('falls back to the city centroid when supplied coordinates are out of bounds / (0,0)', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.service.findUnique.mockResolvedValue({ id: 'svc-1', isActive: true, categoryId: 'cat-1', basePrice: 500, durationMinutes: 60, paymentMode: 'BOTH' });
    prisma.city.findUnique.mockResolvedValue({ id: 'city-1', name: 'Bhopal', state: 'MP', isActive: true, latitude: 23.25, longitude: 77.41 });

    await svc.book(baseDto({ latitude: 0, longitude: 0 }) as any);

    expect(prisma.address.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ latitude: 23.25, longitude: 77.41 }),
    }));
  });
});
