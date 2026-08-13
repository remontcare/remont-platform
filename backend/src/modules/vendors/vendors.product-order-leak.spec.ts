import { ForbiddenException } from '@nestjs/common';
import { ServiceVendorsService } from './vendors.module';

/**
 * Regression coverage for a production incident: Order.vendorId is a plain FK with no
 * type constraint, so nothing at the schema level stops it from being set on a
 * product-only order (serviceId: null). This happened for real — an admin, browsing a
 * master order's two child orders (one PRODUCT, one SERVICE) before AdminService's
 * forceAssignVendor()/listActiveVendors() guards existed, assigned the same Service
 * Partner to both. The product-order child then leaked into that vendor's "My Jobs" list
 * (myJobs() filtered only by vendorId) and would have opened via getJobDetail() too.
 * myJobs()/getJobDetail() are now the last line of defense: a Service Partner's job
 * list/detail view must never surface an order with no serviceId, no matter how vendorId
 * got set on it.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn() },
    order: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
  };
  const whatsapp: any = {};
  const events: any = {};
  const ledger: any = {};
  const service = new ServiceVendorsService(prisma, whatsapp, events, ledger);
  return { service, prisma };
}

describe('ServiceVendorsService.myJobs — product-order leak guard', () => {
  it('filters the query to serviceId not null, not just vendorId', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });

    await service.myJobs('vendor-user-1');

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ vendorId: 'vendor-1', serviceId: { not: null } }),
    }));
  });
});

describe('ServiceVendorsService.getJobDetail — product-order leak guard', () => {
  it('rejects a product-only order (serviceId: null) even when vendorId matches this vendor', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1', status: 'ACTIVE', memberStatus: null });
    prisma.order.findUnique.mockResolvedValue({ id: 'product-order-1', vendorId: 'vendor-1', serviceId: null });

    await expect(service.getJobDetail('vendor-user-1', 'product-order-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still allows a real, assigned service order through', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1', status: 'ACTIVE', memberStatus: null });
    const order = { id: 'service-order-1', vendorId: 'vendor-1', serviceId: 'svc-1' };
    prisma.order.findUnique.mockResolvedValue(order);

    await expect(service.getJobDetail('vendor-user-1', 'service-order-1')).resolves.toBe(order);
  });
});
