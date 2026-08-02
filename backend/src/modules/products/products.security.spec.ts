import { ForbiddenException } from '@nestjs/common';
import { ProductsService } from './products.module';

/**
 * A PENDING_VERIFICATION/SUSPENDED/REJECTED seller must never be able to publish or update a
 * product — the approval gate has to be enforced in the service layer, not just implied by the
 * onboarding UI, since these endpoints are reachable directly with any valid PRODUCT_VENDOR JWT.
 */
function makeService() {
  const prisma: any = {
    productVendor: { findUnique: jest.fn() },
    product: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    cityProduct: { findMany: jest.fn() },
  };
  const service = new ProductsService(prisma);
  return { service, prisma };
}

describe('ProductsService seller approval gate', () => {
  describe('create', () => {
    it.each(['PENDING_VERIFICATION', 'SUSPENDED', 'REJECTED'])(
      'rejects product creation for a %s seller',
      async (status) => {
        const { service, prisma } = makeService();
        prisma.productVendor.findUnique.mockResolvedValue({ id: 'vendor-1', status });

        await expect(service.create('user-1', { name: 'Drill' })).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.product.create).not.toHaveBeenCalled();
      },
    );

    it('allows product creation for an ACTIVE seller', async () => {
      const { service, prisma } = makeService();
      prisma.productVendor.findUnique.mockResolvedValue({ id: 'vendor-1', status: 'ACTIVE' });
      prisma.product.create.mockResolvedValue({ id: 'product-1' });

      await expect(service.create('user-1', { name: 'Drill' })).resolves.toBeDefined();
      expect(prisma.product.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects product updates for a SUSPENDED seller even when they own the product', async () => {
      const { service, prisma } = makeService();
      prisma.productVendor.findUnique.mockResolvedValue({ id: 'vendor-1', status: 'SUSPENDED' });

      await expect(service.update('user-1', 'product-1', { name: 'New name' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('allows product updates for an ACTIVE seller who owns the product', async () => {
      const { service, prisma } = makeService();
      prisma.productVendor.findUnique.mockResolvedValue({ id: 'vendor-1', status: 'ACTIVE' });
      prisma.product.findUnique.mockResolvedValue({ id: 'product-1', vendorId: 'vendor-1' });
      prisma.product.update.mockResolvedValue({ id: 'product-1', name: 'New name' });

      await expect(service.update('user-1', 'product-1', { name: 'New name' })).resolves.toBeDefined();
      expect(prisma.product.update).toHaveBeenCalled();
    });
  });
});
