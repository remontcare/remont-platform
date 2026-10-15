import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.module';

/**
 * Partner "I have arrived" (fresh location, server-decided verification, recorded once, order
 * status unchanged) and the customer cancel guard: after arrival or start a cancellation is
 * never instant — the API answers 409 CANCELLATION_REVIEW_REQUIRED; before arrival the existing
 * instant cancel is unchanged.
 */
const ADDRESS = { snapshotLatitude: 23.2599, snapshotLongitude: 77.4126 };
function makeService(orderOverrides: any = {}) {
  let order: any = { id: 'order-1', vendorId: 'vendor-1', customerId: 'cust-1', status: 'VENDOR_EN_ROUTE', arrivedAt: null, type: 'SERVICE', items: [], leadCostAmount: 0, ...ADDRESS, ...orderOverrides };
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(async ({ where }: any) => (where.userId === 'vendor-user-1' ? { id: 'vendor-1' } : { id: 'vendor-9' })) },
    order: {
      findUnique: jest.fn(async () => order),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.arrivedAt === null && order.arrivedAt) return { count: 0 };
        order = { ...order, ...data };
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => { order = { ...order, ...data }; return order; }),
    },
    orderTimeline: { create: jest.fn(async () => ({})) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, get order() { return order; } };
}

describe('Partner arrival', () => {
  it('within the radius with good accuracy → VERIFIED; status unchanged; timeline written once', async () => {
    const t = makeService();
    const res = await t.svc.markArrived('vendor-user-1', 'order-1', { latitude: 23.2601, longitude: 77.4127, accuracyM: 15 });
    expect(res.alreadyRecorded).toBe(false);
    expect(t.order.arrivalVerification).toBe('VERIFIED');
    expect(t.order.status).toBe('VENDOR_EN_ROUTE');
    expect(t.prisma.orderTimeline.create).toHaveBeenCalledTimes(1);
  });

  it('a repeat call keeps the first record — no duplicate events', async () => {
    const t = makeService();
    await t.svc.markArrived('vendor-user-1', 'order-1', { latitude: 23.2601, longitude: 77.4127, accuracyM: 15 });
    const again = await t.svc.markArrived('vendor-user-1', 'order-1', { latitude: 25, longitude: 80, accuracyM: 5 });
    expect(again.alreadyRecorded).toBe(true);
    expect(t.order.arrivalVerification).toBe('VERIFIED');
    expect(t.prisma.orderTimeline.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ latitude: 23.30, longitude: 77.45, accuracyM: 10 }, 'NOT_VERIFIED_TOO_FAR'],
    [{ latitude: 23.2601, longitude: 77.4127, accuracyM: 500 }, 'NOT_VERIFIED_LOW_ACCURACY'],
    [{ latitude: 23.2601, longitude: 77.4127 }, 'NOT_VERIFIED_LOW_ACCURACY'], // accuracy unknown
    [{ locationError: 'TIMEOUT' }, 'NOT_VERIFIED_NO_LOCATION'],
    [{ latitude: 0, longitude: 0, accuracyM: 5 }, 'NOT_VERIFIED_NO_LOCATION'], // Null Island is never trusted
  ])('%p → %s (never marked verified on failure)', async (body, expected) => {
    const t = makeService();
    await t.svc.markArrived('vendor-user-1', 'order-1', body as any);
    expect(t.order.arrivalVerification).toBe(expected);
    if (expected === 'NOT_VERIFIED_NO_LOCATION') expect(t.order.arrivalLatitude).toBeNull();
  });

  it('an address without map coordinates can never be verified', async () => {
    const t = makeService({ snapshotLatitude: null, snapshotLongitude: null });
    await t.svc.markArrived('vendor-user-1', 'order-1', { latitude: 23.26, longitude: 77.41, accuracyM: 5 });
    expect(t.order.arrivalVerification).toBe('NOT_VERIFIED_NO_ADDRESS_COORDINATES');
  });

  it('the admin-configured radius is honoured', async () => {
    const t = makeService();
    t.prisma.siteSetting.findUnique.mockImplementation(async ({ where }: any) => (where.key === 'arrival_verification_radius_m' ? { value: '5000' } : null));
    await t.svc.markArrived('vendor-user-1', 'order-1', { latitude: 23.28, longitude: 77.43, accuracyM: 10 });
    expect(t.order.arrivalVerification).toBe('VERIFIED');
  });

  it('only the assigned partner, and only before the job starts', async () => {
    await expect(makeService().svc.markArrived('other-user', 'order-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeService({ status: 'STARTED' }).svc.markArrived('vendor-user-1', 'order-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Customer cancel guard', () => {
  it('after arrival → 409 CANCELLATION_REVIEW_REQUIRED, nothing cancelled', async () => {
    const t = makeService({ arrivedAt: new Date() });
    const err: any = await t.svc.cancel('cust-1', 'order-1', 'changed mind').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().error).toBe('CANCELLATION_REVIEW_REQUIRED');
    expect(t.order.status).toBe('VENDOR_EN_ROUTE');
  });

  it('after the job started → 409 as well (was an instant charge-free cancel)', async () => {
    const t = makeService({ status: 'STARTED' });
    await expect(t.svc.cancel('cust-1', 'order-1', 'x')).rejects.toBeInstanceOf(ConflictException);
  });

  it('before arrival the existing instant cancel is unchanged', async () => {
    const t = makeService({ status: 'VENDOR_ASSIGNED' });
    const res: any = await t.svc.cancel('cust-1', 'order-1', 'x');
    expect(res.status).toBe('CANCELLED');
  });
});

describe('Start OTP closes self-service cancellation (approved rule B)', () => {
  it('start OTP shared (startOtpVerified) → 409 SERVICE_STARTED: complaint only, nothing cancelled', async () => {
    const t = makeService({ arrivedAt: new Date(), startOtpVerified: true, status: 'VENDOR_EN_ROUTE' });
    const err: any = await t.svc.cancel('cust-1', 'order-1', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().error).toBe('SERVICE_STARTED');
    expect(t.order.status).toBe('VENDOR_EN_ROUTE');
  });
  it('arrived but no start OTP yet → still the cancellation review (not complaint-only)', async () => {
    const t = makeService({ arrivedAt: new Date(), startOtpVerified: false });
    const err: any = await t.svc.cancel('cust-1', 'order-1', 'x').catch((e) => e);
    expect(err.getResponse().error).toBe('CANCELLATION_REVIEW_REQUIRED');
  });
});

describe('Cancellation before arrival — money already received is never lost track of', () => {
  function withRefundStore(t: any, open: any = null) {
    t.prisma.refundRequest = { findFirst: jest.fn(async () => open), create: jest.fn(async ({ data }: any) => ({ id: 'rr-auto', ...data })) };
    t.prisma.refundRequestLog = { create: jest.fn(async () => ({})) };
  }
  it('a PAID booking cancelled before arrival records a refund REQUEST for admin review (no money moves)', async () => {
    const t = makeService({ status: 'VENDOR_ASSIGNED', paymentStatus: 'PAID', totalAmount: 1180 });
    withRefundStore(t);
    await t.svc.cancel('cust-1', 'order-1', 'plans changed');
    expect(t.prisma.refundRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orderId: 'order-1', customerId: 'cust-1', status: 'REQUESTED' }) });
    expect(t.order.status).toBe('CANCELLED');
  });
  it('wallet money counts as received too', async () => {
    const t = makeService({ status: 'CONFIRMED', paymentStatus: 'PENDING', walletUsed: 50 });
    withRefundStore(t);
    await t.svc.cancel('cust-1', 'order-1', 'x');
    expect(t.prisma.refundRequest.create).toHaveBeenCalledTimes(1);
  });
  it('an unpaid cash booking creates nothing; an already-open request is not duplicated', async () => {
    const unpaid = makeService({ status: 'CONFIRMED', paymentStatus: 'PENDING', walletUsed: 0 });
    withRefundStore(unpaid);
    await unpaid.svc.cancel('cust-1', 'order-1', 'x');
    expect(unpaid.prisma.refundRequest.create).not.toHaveBeenCalled();
    const paid = makeService({ status: 'CONFIRMED', paymentStatus: 'PAID' });
    withRefundStore(paid, { id: 'rr-open' });
    await paid.svc.cancel('cust-1', 'order-1', 'x');
    expect(paid.prisma.refundRequest.create).not.toHaveBeenCalled();
  });
});
