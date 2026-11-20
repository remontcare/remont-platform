import { ServiceVendorsService } from './vendors.module';
import { OrdersService } from '../orders/orders.module';

/**
 * The extra-work OTP is the customer's approval of a charge. Job list/detail (and the shared
 * order detail) are served to the assigned partner, so they must never select `otp` — with it
 * the partner could approve their own extra work.
 */
function expectNoOtp(include: any) {
  expect(include.extraWorkItems.select).toBeDefined();
  expect(include.extraWorkItems.select.otp).toBeUndefined();
  expect(include.extraWorkItems.select).toMatchObject({ id: true, description: true, amount: true, customerApproved: true });
}

describe('extra-work OTP is never returned in partner-visible order responses', () => {
  function vendorService() {
    const prisma: any = {
      serviceVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', userId: 'u1', status: 'ACTIVE' }) },
      order: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ id: 'o1', vendorId: 'v1', serviceId: 's1' }) },
    };
    return { prisma, service: new ServiceVendorsService(prisma, {} as any, {} as any, {} as any) };
  }

  it('GET /vendors/service/me/jobs', async () => {
    const { prisma, service } = vendorService();
    await service.myJobs('u1');
    expectNoOtp(prisma.order.findMany.mock.calls[0][0].include);
  });

  it('GET /vendors/service/me/jobs/:id', async () => {
    const { prisma, service } = vendorService();
    await service.getJobDetail('u1', 'o1');
    expectNoOtp(prisma.order.findUnique.mock.calls[0][0].include);
  });

  it('GET /orders/:id (shared by customer and assigned partner) and GET /orders/mine', async () => {
    const prisma: any = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ id: 'o1', customerId: 'c1', vendor: null }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const orders = Object.create(OrdersService.prototype);
    orders.prisma = prisma;
    await orders.getOne('c1', 'o1');
    expectNoOtp(prisma.order.findUnique.mock.calls[0][0].include);
    await orders.myOrders('c1');
    expectNoOtp(prisma.order.findMany.mock.calls[0][0].include);
  });
});
