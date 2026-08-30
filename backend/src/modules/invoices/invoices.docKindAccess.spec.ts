import { ForbiddenException } from '@nestjs/common';
import { InvoicesService } from './invoices.module';

/**
 * Phase 8 (H-08 + Workstream 5) — getPdfBuffer()'s docKind was hardcoded to 'CUSTOMER' at
 * the controller, so a seller/partner had no way to ever reach their OWN commission/
 * settlement-invoice page. Making docKind caller-selectable surfaced a dormant gap:
 * isAuthorizedForInvoice() is "any party to this order" for every docKind, which was
 * harmless while only 'CUSTOMER' was ever requested — a MARKETPLACE_PRODUCT order's REMONT
 * page (Remont's commission invoice TO THE SELLER, never the customer) must stay
 * seller/admin-only even though the customer is otherwise authorized on that same order.
 */
function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn() },
    siteSetting: { findMany: jest.fn().mockResolvedValue([]) }, // getBillingCompanyConfig() — only reached once authorization passes
  };
  return { svc: new InvoicesService(prisma), prisma };
}

function marketplaceOrder(overrides: any = {}) {
  return {
    id: 'order-1', customerId: 'cust-1', vendor: null,
    invoice: { transactionType: 'MARKETPLACE_PRODUCT', invoiceNumber: 'INV-CTI-2026-27-000001' },
    customer: { name: 'Cust' }, address: null, masterOrder: null, service: null,
    items: [{ product: { vendor: { userId: 'seller-user-1' } } }],
    ...overrides,
  };
}

describe('InvoicesService.getPdfBuffer — docKind access control (H-08/Workstream 5)', () => {
  it('the seller CAN access the REMONT (commission) page for their own MARKETPLACE_PRODUCT order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(marketplaceOrder());
    // May still fail later inside actual PDF rendering (order fixture is minimal) — the
    // point is it must get PAST authorization, i.e. never a ForbiddenException.
    await expect(svc.getPdfBuffer('seller-user-1', 'order-1', 'REMONT')).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('the CUSTOMER cannot access the REMONT (commission-to-seller) page for a MARKETPLACE_PRODUCT order — not addressed to them', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(marketplaceOrder());
    await expect(svc.getPdfBuffer('cust-1', 'order-1', 'REMONT')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an unrelated user cannot access ANY docKind for this order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(marketplaceOrder());
    await expect(svc.getPdfBuffer('random-user', 'order-1', 'CUSTOMER')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getPdfBuffer('random-user', 'order-1', 'REMONT')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the customer CAN still access the CUSTOMER page for their own order (unaffected by the REMONT tightening)', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(marketplaceOrder());
    await expect(svc.getPdfBuffer('cust-1', 'order-1', 'CUSTOMER')).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('the customer CAN access the REMONT page for a PLATFORM_SERVICE order — that page IS addressed to them there', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-2', customerId: 'cust-1', vendor: { userId: 'partner-user-1' },
      invoice: { transactionType: 'PLATFORM_SERVICE' },
      customer: { name: 'Cust' }, address: null, masterOrder: null, service: null, items: [],
    });
    await expect(svc.getPdfBuffer('cust-1', 'order-2', 'REMONT')).rejects.not.toBeInstanceOf(ForbiddenException);
  });
});
