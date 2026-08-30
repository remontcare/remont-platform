import { ReportsService } from './reports.module';

/**
 * Phase 8 (Workstream 2, reconciliation control E — Order -> Seller Settlement).
 * sellerSettlementReconciliation() recomputes each settled PRODUCT order's expected net
 * seller credit from its own snapshotted fields (the SAME formula
 * ProductLedgerService.settleProductOrder() used to post the ledger) and compares it
 * against what was actually posted — this should always match by construction; a mismatch
 * is surfaced as an explicit, never-auto-corrected exception.
 */
function makeService() {
  const prisma: any = {
    order: { findMany: jest.fn().mockResolvedValue([]) },
    productVendorLedgerEntry: { findMany: jest.fn().mockResolvedValue([]) },
    tcsRecord: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { svc: new ReportsService(prisma), prisma };
}

const baseOrder = {
  id: 'order-1', orderNumber: 'REM-1', productsAmount: 1000, productsTaxableAmount: 1000,
  productFeeBreakdown: { commission: { amount: 80 }, gstOnFees: { amount: 14.4 }, marketing: { amount: 0 }, gateway: { amount: 0 }, delivery: { amount: 50 } },
  items: [{ vendorId: 'seller-a' }],
};

describe('ReportsService.sellerSettlementReconciliation (Workstream 2)', () => {
  it('an order whose posted ledger entries exactly match the expected formula is RECONCILED, not an exception', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findMany.mockResolvedValue([baseOrder]);
    // expectedNetCredit = 1000 - 80 - 14.4 - 0 - 0 - 50 = 855.6
    prisma.productVendorLedgerEntry.findMany.mockResolvedValue([
      { orderId: 'order-1', type: 'GROSS_SALE', amount: 1000 },
      { orderId: 'order-1', type: 'COMMISSION', amount: -80 },
      { orderId: 'order-1', type: 'GST_ON_FEES', amount: -14.4 },
      { orderId: 'order-1', type: 'DELIVERY_COST', amount: -50 },
      { orderId: 'order-1', type: 'HOLD', amount: -855.6 }, // excluded from the comparison — lifecycle transfer, not revenue
    ]);
    const result = await svc.sellerSettlementReconciliation({});
    expect(result.exceptions).toHaveLength(0);
    expect(result.reconciled).toBe(1);
  });

  it('a mismatch is surfaced as an explicit RECONCILIATION_EXCEPTION — never silently corrected', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findMany.mockResolvedValue([baseOrder]);
    prisma.productVendorLedgerEntry.findMany.mockResolvedValue([
      { orderId: 'order-1', type: 'GROSS_SALE', amount: 1000 },
      { orderId: 'order-1', type: 'COMMISSION', amount: -80 },
      // GST_ON_FEES and DELIVERY_COST entries missing/never posted — a real drift.
    ]);
    const result = await svc.sellerSettlementReconciliation({});
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({ orderId: 'order-1', status: 'RECONCILIATION_EXCEPTION', sellerId: 'seller-a' });
    expect(result.exceptions[0].expectedNetCredit).toBe(855.6);
    expect(result.exceptions[0].actualNetCredit).toBe(920); // 1000 - 80
  });

  it('an order with no ledger entries at all (never settled — e.g. not yet delivered) is skipped, not flagged as a mismatch', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findMany.mockResolvedValue([baseOrder]);
    prisma.productVendorLedgerEntry.findMany.mockResolvedValue([]);
    const result = await svc.sellerSettlementReconciliation({});
    expect(result.exceptions).toHaveLength(0);
    expect(result.reconciled).toBe(0);
    expect(result.checked).toBe(1);
  });

  it('TCS is included in the expected formula when a TcsRecord exists for the order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findMany.mockResolvedValue([baseOrder]);
    prisma.tcsRecord.findMany.mockResolvedValue([{ orderId: 'order-1', totalAmount: 10 }]);
    // expectedNetCredit = 1000 - 80 - 14.4 - 0 - 0 - 50 - 10 = 845.6
    prisma.productVendorLedgerEntry.findMany.mockResolvedValue([
      { orderId: 'order-1', type: 'GROSS_SALE', amount: 1000 },
      { orderId: 'order-1', type: 'COMMISSION', amount: -80 },
      { orderId: 'order-1', type: 'GST_ON_FEES', amount: -14.4 },
      { orderId: 'order-1', type: 'DELIVERY_COST', amount: -50 },
      { orderId: 'order-1', type: 'TCS', amount: -10 },
    ]);
    const result = await svc.sellerSettlementReconciliation({});
    expect(result.exceptions).toHaveLength(0);
  });
});
