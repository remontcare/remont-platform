import { ServiceVendorsService } from './vendors.module';
import { AdminService } from '../admin/admin.module';
import { OrdersService } from '../orders/orders.module';
import { ARRIVAL_RESET_DATA } from '../../common';

/**
 * Audit M1 — a partner's arrival record never carries over to another partner: rejecting the job
 * or an admin re-assigning it to someone else clears it, and the new partner records their own.
 */
const ARRIVED = { arrivedAt: new Date(), arrivalVerification: 'VERIFIED', arrivalDistanceM: 12, arrivalLatitude: 23.26, arrivalLongitude: 77.41, arrivalAccuracyM: 8, arrivalNote: null };

describe('M1 — arrival evidence is cleared when the partner changes', () => {
  it('rejectJob returns the job to the pool WITHOUT the rejecting partner\'s arrival', async () => {
    const prisma: any = {
      serviceVendor: { findUnique: jest.fn(async () => ({ id: 'vendor-a' })) },
      order: { findUnique: jest.fn(async () => ({ id: 'o1', vendorId: 'vendor-a', status: 'VENDOR_ASSIGNED', ...ARRIVED })), update: jest.fn(async (a: any) => a.data) },
    };
    const svc = new ServiceVendorsService(prisma, {} as any, {} as any, {} as any);
    await svc.rejectJob('vendor-user-a', 'o1');
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { vendorId: null, status: 'CONFIRMED', ...ARRIVAL_RESET_DATA } });
  });

  function admin(existing: any) {
    const prisma: any = {
      order: { findUnique: jest.fn(async () => existing), update: jest.fn(async (a: any) => ({ id: 'o1', vendor: { userId: 'u' }, ...a.data })) },
      orderTimeline: { create: jest.fn(async () => ({})) },
    };
    const svc = new AdminService(prisma, { get: () => undefined } as any, {} as any, {} as any, {} as any, { emit: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma };
  }

  it('admin re-assigns to a DIFFERENT partner → the previous arrival is cleared (and noted in the timeline)', async () => {
    const { svc, prisma } = admin({ serviceId: 's1', vendorId: 'vendor-a', arrivedAt: ARRIVED.arrivedAt });
    await svc.forceAssignVendor('o1', 'vendor-b', 'admin-1');
    expect(prisma.order.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ vendorId: 'vendor-b', ...ARRIVAL_RESET_DATA }));
    expect(prisma.orderTimeline.create.mock.calls[0][0].data.note).toMatch(/arrival record cleared/);
  });

  it('re-assigning the SAME partner keeps their arrival', async () => {
    const { svc, prisma } = admin({ serviceId: 's1', vendorId: 'vendor-a', arrivedAt: ARRIVED.arrivedAt });
    await svc.forceAssignVendor('o1', 'vendor-a', 'admin-1');
    expect(prisma.order.update.mock.calls[0][0].data).not.toHaveProperty('arrivedAt');
  });

  it('after the reset, the NEW partner records their own arrival (not "already recorded")', async () => {
    let order: any = { id: 'o1', vendorId: 'vendor-b', status: 'VENDOR_EN_ROUTE', snapshotLatitude: 23.2599, snapshotLongitude: 77.4126, ...ARRIVAL_RESET_DATA };
    const prisma: any = {
      serviceVendor: { findUnique: jest.fn(async () => ({ id: 'vendor-b' })) },
      order: {
        findUnique: jest.fn(async () => order),
        updateMany: jest.fn(async ({ where, data }: any) => { if (where.arrivedAt === null && order.arrivedAt) return { count: 0 }; order = { ...order, ...data }; return { count: 1 }; }),
      },
      siteSetting: { findUnique: jest.fn(async () => null) },
      orderTimeline: { create: jest.fn(async () => ({})) },
    };
    const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svc.markArrived('vendor-user-b', 'o1', { latitude: 23.2600, longitude: 77.4127, accuracyM: 10 });
    expect(r.alreadyRecorded).toBe(false);
    expect(r.arrival.arrivalVerification).toBe('VERIFIED');
    expect(prisma.orderTimeline.create).toHaveBeenCalledTimes(1);
  });
});
