import { NotFoundException } from '@nestjs/common';
import { ProductVendorsService } from './vendors.module';

/**
 * Phase 8 (H-08) — a seller previously had no way to see their own TCS withholdings or
 * credit notes at all (both are Phase 6/7 data-only additions with no seller-facing read
 * surface). tcsHistory()/creditNoteHistory() reuse requireVendor() — the SAME ownership
 * check every other me/* endpoint in this class already uses — so a seller can never see
 * another seller's TCS or a credit note for an order they didn't sell on.
 */
function makeService() {
  const prisma: any = {
    productVendor: { findUnique: jest.fn() },
    tcsRecord: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new ProductVendorsService(prisma, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

describe('ProductVendorsService.tcsHistory (H-08)', () => {
  it('scopes the query to the CALLER\'S own vendor id — never accepts a vendorId from the caller', async () => {
    const { service, prisma } = makeService();
    prisma.productVendor.findUnique.mockResolvedValue({ id: 'seller-a', userId: 'user-a' });
    await service.tcsHistory('user-a');
    expect(prisma.tcsRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sellerId: 'seller-a' } }));
  });

  it('a different seller\'s call resolves to THEIR OWN id, never seller-a\'s — no cross-seller leak', async () => {
    const { service, prisma } = makeService();
    prisma.productVendor.findUnique.mockResolvedValue({ id: 'seller-b', userId: 'user-b' });
    await service.tcsHistory('user-b');
    expect(prisma.tcsRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sellerId: 'seller-b' } }));
  });

  it('rejects a caller with no seller profile at all', async () => {
    const { service, prisma } = makeService();
    prisma.productVendor.findUnique.mockResolvedValue(null);
    await expect(service.tcsHistory('random-user')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProductVendorsService.creditNoteHistory (H-08)', () => {
  it('only ever queries credit notes for orders THIS seller\'s own products appear on', async () => {
    const { service, prisma } = makeService();
    prisma.productVendor.findUnique.mockResolvedValue({ id: 'seller-a', userId: 'user-a' });
    prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }, { id: 'order-2' }]);
    await service.creditNoteHistory('user-a');
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { items: { some: { vendorId: 'seller-a' } } } }));
    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: { in: ['order-1', 'order-2'] } } }));
  });

  it('returns an empty list (never queries CreditNote at all) when the seller has no orders — cannot accidentally return unscoped/all credit notes', async () => {
    const { service, prisma } = makeService();
    prisma.productVendor.findUnique.mockResolvedValue({ id: 'seller-a', userId: 'user-a' });
    prisma.order.findMany.mockResolvedValue([]);
    const result = await service.creditNoteHistory('user-a');
    expect(result).toEqual([]);
    expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
  });
});
