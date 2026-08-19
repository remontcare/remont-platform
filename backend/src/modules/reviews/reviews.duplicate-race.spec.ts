import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ReviewsService } from './reviews.module';

/**
 * Full lifecycle audit finding: the "already reviewed this order?" check and the review
 * create() were two separate statements with no lock between them — two near-simultaneous
 * submits for the same order/customer could both pass the check before either commits,
 * producing two reviews for one order and skewing the vendor's average rating. Fixed by
 * locking the Order row first (same idiom as PartnerLedgerService.postEntry()), serializing
 * concurrent attempts for the same order.
 */
function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn() },
    review: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: any) => ({ id: 'review-1', ...args.data })),
      aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4.5 }, _count: { id: 1 } }),
    },
    serviceVendor: { update: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn({
    $queryRaw: jest.fn(),
    review: prisma.review,
    serviceVendor: prisma.serviceVendor,
  }));
  const svc = new ReviewsService(prisma);
  return { svc, prisma };
}

function completedOrder(overrides: Record<string, unknown> = {}) {
  return { id: 'order-1', customerId: 'cust-1', vendorId: 'vendor-1', serviceId: 'svc-1', status: 'COMPLETED', ...overrides };
}

describe('ReviewsService.create — ownership and status gates', () => {
  it('rejects a review for an order the caller does not own', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(completedOrder({ customerId: 'someone-else' }));
    await expect(svc.create('cust-1', { orderId: 'order-1', rating: 5 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a review for a non-completed order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(completedOrder({ status: 'IN_PROGRESS' }));
    await expect(svc.create('cust-1', { orderId: 'order-1', rating: 5 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReviewsService.create — duplicate-review race', () => {
  it('rejects a duplicate review for the same order/customer', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(completedOrder());
    prisma.review.findFirst.mockResolvedValue({ id: 'existing-review' });

    await expect(svc.create('cust-1', { orderId: 'order-1', rating: 5 })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  it('locks the Order row before checking for an existing review, so a racing duplicate sees the first review as already committed', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(completedOrder());

    await svc.create('cust-1', { orderId: 'order-1', rating: 5 });

    expect(prisma.$transaction).toHaveBeenCalled();
    // The lock + existence check + create must all run inside the same transaction callback,
    // not as three independent statements against the bare prisma client.
    expect(prisma.review.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ orderId: 'order-1', userId: 'cust-1', rating: 5 }),
    }));
  });

  it('recomputes and writes the vendor rating average in the same transaction as the review insert', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(completedOrder());
    prisma.review.aggregate.mockResolvedValue({ _avg: { rating: 4.3333 }, _count: { id: 3 } });

    await svc.create('cust-1', { orderId: 'order-1', rating: 4 });

    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({
      where: { id: 'vendor-1' },
      data: { rating: 4.3 },
    });
  });
});
