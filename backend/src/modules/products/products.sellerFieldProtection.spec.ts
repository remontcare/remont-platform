import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.module';

/** Seller product bodies reach Prisma; relation writes and system counters must not. */
function makeService() {
  const prisma: any = {
    productVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'pv1', status: 'ACTIVE' }) },
    product: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', vendorId: 'pv1', images: [] }),
      update: jest.fn().mockImplementation(async ({ data }) => ({ id: 'p1', images: [], ...data })),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'p1', images: [], ...data })),
    },
  };
  return { prisma, service: new ProductsService(prisma) };
}

describe('ProductsService seller field protection', () => {
  it('update drops relation writes and system-managed fields but keeps normal columns', async () => {
    const { service, prisma } = makeService();
    await service.update('u1', 'p1', {
      price: 499, stock: 7, returnable: false,
      vendor: { connect: { id: 'someone-else' } },
      category: { update: { name: 'pwned' } },
      reviews: { create: [{ rating: 5 }] },
      rating: 5, reviewCount: 999, views: 1e6, slug: 'hijack', id: 'other',
    });
    expect(prisma.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { price: 499, stock: 7, returnable: false } });
  });

  it('create cannot seed fake rating/reviews', async () => {
    const { service, prisma } = makeService();
    await service.create('u1', { name: 'Fan', categoryId: 'c1', price: 100, rating: 5, reviewCount: 50, reviews: { create: [] } });
    const data = prisma.product.create.mock.calls[0][0].data;
    expect(data.rating).toBeUndefined();
    expect(data.reviewCount).toBeUndefined();
    expect(data.reviews).toBeUndefined();
    expect(data.vendorId).toBe('pv1');
  });

  it('rejects non-http image URL schemes', async () => {
    const { service } = makeService();
    await expect(service.update('u1', 'p1', { images: ['javascript:alert(1)'] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('u1', 'p1', { images: [{ evil: true }] })).rejects.toBeInstanceOf(BadRequestException);
  });
});
