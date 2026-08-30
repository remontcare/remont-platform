import { ProductLedgerService } from './product-ledger.module';

/**
 * Phase 7 (C-10) — GST TCS withheld at settlement, seller-wise, and reversed on return.
 * See common/gstCompliance.spec.ts for the underlying rate-resolution/split unit tests.
 */
function makeTx(overrides: Record<string, any> = {}) {
  return {
    $queryRaw: jest.fn(),
    productVendorLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async (args: any) => args.data) },
    productVendorHold: { create: jest.fn(async (args: any) => ({ id: 'hold-1', ...args.data })), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    productVendor: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ state: 'Madhya Pradesh' }) },
    order: { findUnique: jest.fn(), update: jest.fn() },
    tcsRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(async (args: any) => args.data), update: jest.fn(async (args: any) => args.data) },
    ...overrides,
  };
}

function makeService(tcsRate: number | null, companyState = 'Madhya Pradesh') {
  const prisma: any = {
    taxConfig: { findFirst: jest.fn().mockResolvedValue(tcsRate != null ? { rate: tcsRate } : null) },
    siteSetting: {
      // getBillingCompanyConfig() reads every 'billing'-group row at once — only company_state matters here.
      findMany: jest.fn(async () => [{ key: 'company_state', value: companyState }]),
    },
  };
  return { service: new ProductLedgerService(prisma), prisma };
}

const order = {
  id: 'order-1',
  productsAmount: 1000,
  productsTaxableAmount: 1000,
  productFeeBreakdown: {
    commission: { amount: 80, ruleId: 'r1', ruleLabel: 'Category rule: 8%' },
    marketing: { amount: 0, ruleId: null, ruleLabel: 'No rule — ₹0' },
    gateway: { amount: 0, ruleId: null, ruleLabel: 'No rule — ₹0' },
    gstOnFees: { amount: 0, ratePercent: 18 },
  },
  items: [{ vendorId: 'seller-a', product: { returnWindowDays: 7 } }],
};
const shipment = { logisticsProviderId: 'lp-1', actualDeliveryCost: 0, deliveredAt: null };

describe('ProductLedgerService.settleProductOrder — TCS (C-10)', () => {
  it('1. TCS non-applicable: no TCS rate configured — no TCS entry posted, no TcsRecord created, settlement unaffected', async () => {
    const { service, prisma } = makeService(null);
    const tx = makeTx();
    await service.settleProductOrder(tx, order as any, shipment as any, new Date('2026-08-30'));
    const types = tx.productVendorLedgerEntry.create.mock.calls.map((c: any) => c[0].data.type);
    expect(types).not.toContain('TCS');
    expect(tx.tcsRecord.create).not.toHaveBeenCalled();
    void prisma; // taxConfig mock already asserted via resolveTcsRatePercent's own unit tests
  });

  it('2. TCS applicable: 1% withheld on the same taxable base GROSS_SALE was credited against, posted as its own ledger entry (never merged into COMMISSION)', async () => {
    const { service } = makeService(1); // 1% TCS configured
    const tx = makeTx();
    await service.settleProductOrder(tx, order as any, shipment as any, new Date('2026-08-30T00:00:00Z'));
    const tcsCall = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'TCS')!;
    expect(tcsCall[0].data.amount).toBe(-10); // 1% of 1000 taxable base
    const commissionCall = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'COMMISSION')!;
    expect(commissionCall[0].data.amount).toBe(-80); // commission untouched — TCS is separate

    // GROSS_SALE (1000) - COMMISSION(80) - TCS(10) = 910 net credit, reflected in totalEarnings.
    expect(tx.productVendor.update.mock.calls[0][0].data.totalEarnings.increment).toBeCloseTo(910, 5);
  });

  it('3. TCS seller-wise: the TcsRecord is scoped to the seller who made the sale, with financial year/tax period recorded', async () => {
    const { service } = makeService(1);
    const tx = makeTx();
    await service.settleProductOrder(tx, order as any, shipment as any, new Date('2026-08-30T00:00:00Z'));
    const data = tx.tcsRecord.create.mock.calls[0][0].data;
    expect(data.sellerId).toBe('seller-a');
    expect(data.orderId).toBe('order-1');
    expect(data.financialYear).toBe('2026-27');
    expect(data.taxPeriod).toBe('2026-08');
    expect(Number(data.taxableBase)).toBe(1000);
    expect(Number(data.tcsRatePercent)).toBe(1);
    expect(Number(data.totalAmount)).toBe(10);
  });

  it('4. TCS settlement reconciliation: CGST+SGST split for an intra-state seller matches computeTcsSplit exactly', async () => {
    const { service } = makeService(1, 'Madhya Pradesh');
    const tx = makeTx({ productVendor: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ state: 'Madhya Pradesh' }) } });
    await service.settleProductOrder(tx, order as any, shipment as any, new Date('2026-08-30T00:00:00Z'));
    const data = tx.tcsRecord.create.mock.calls[0][0].data;
    expect(Number(data.cgstAmount)).toBe(5);
    expect(Number(data.sgstAmount)).toBe(5);
    expect(Number(data.igstAmount)).toBe(0);
    expect(Number(data.cgstAmount) + Number(data.sgstAmount)).toBe(Number(data.totalAmount));
  });
});

describe('ProductLedgerService.reverseSettlement — TCS return/credit-note adjustment (C-10)', () => {
  it('5. a return credits TCS back to the seller proportionally and updates TcsRecord.reversedAmount — never silently left uncorrected', async () => {
    const { service } = makeService(1);
    const tx = makeTx({
      order: {
        findUnique: jest.fn().mockResolvedValue({ productFeeBreakdown: order.productFeeBreakdown, productsAmount: 1000, productsTaxableAmount: 1000, items: [{ vendorId: 'seller-a' }] }),
        update: jest.fn(),
      },
      tcsRecord: {
        findUnique: jest.fn().mockResolvedValue({ orderId: 'order-1', totalAmount: 10, reversedAmount: 0, status: 'COLLECTED' }),
        update: jest.fn(async (args: any) => args.data),
        create: jest.fn(),
      },
    });
    await service.reverseSettlement(tx, 'order-1', 1, 'RETURN'); // full return
    const tcsReversalCall = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'RETURN_ADJUSTMENT' && c[0].data.notes.startsWith('TCS'))!;
    expect(tcsReversalCall[0].data.amount).toBe(10); // credited back in full
    expect(tx.tcsRecord.update).toHaveBeenCalledWith({ where: { orderId: 'order-1' }, data: { reversedAmount: 10, status: 'ADJUSTED' } });
  });

  it('a PARTIAL return reverses only its proportional share of TCS, and status stays COLLECTED (not fully adjusted)', async () => {
    const { service } = makeService(1);
    const tx = makeTx({
      order: {
        findUnique: jest.fn().mockResolvedValue({ productFeeBreakdown: order.productFeeBreakdown, productsAmount: 1000, productsTaxableAmount: 1000, items: [{ vendorId: 'seller-a' }] }),
        update: jest.fn(),
      },
      tcsRecord: {
        findUnique: jest.fn().mockResolvedValue({ orderId: 'order-1', totalAmount: 10, reversedAmount: 0, status: 'COLLECTED' }),
        update: jest.fn(async (args: any) => args.data),
        create: jest.fn(),
      },
    });
    await service.reverseSettlement(tx, 'order-1', 0.5, 'RETURN'); // 50% return
    const tcsReversalCall = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'RETURN_ADJUSTMENT' && c[0].data.notes.startsWith('TCS'))!;
    expect(tcsReversalCall[0].data.amount).toBe(5); // 50% of 10
    expect(tx.tcsRecord.update).toHaveBeenCalledWith({ where: { orderId: 'order-1' }, data: { reversedAmount: 5, status: 'COLLECTED' } });
  });

  it('a return on an order with no TcsRecord (TCS was never applicable) is unaffected — no crash, no phantom reversal', async () => {
    const { service } = makeService(null);
    const tx = makeTx({
      order: { findUnique: jest.fn().mockResolvedValue({ productFeeBreakdown: order.productFeeBreakdown, productsAmount: 1000, productsTaxableAmount: 1000, items: [{ vendorId: 'seller-a' }] }), update: jest.fn() },
    });
    await expect(service.reverseSettlement(tx, 'order-1', 1, 'RETURN')).resolves.toBeUndefined();
    expect(tx.productVendorLedgerEntry.create.mock.calls.some((c: any) => c[0].data.type === 'RETURN_ADJUSTMENT' && c[0].data.notes?.startsWith('TCS'))).toBe(false);
  });
});
