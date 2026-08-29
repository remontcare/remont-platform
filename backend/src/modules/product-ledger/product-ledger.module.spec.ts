import { ProductLedgerService, ProductHoldSweepService } from './product-ledger.module';

/**
 * Phase 7 — PRODUCT-seller marketplace settlement ledger. Same single-entry-running-
 * balance idiom and row-lock race-safety as PartnerLedgerService (see partner-ledger.
 * module.spec.ts) — mirrored here for the ProductVendor-keyed tables.
 */
function makeTx(overrides: Record<string, any> = {}) {
  return {
    $queryRaw: jest.fn(),
    productVendorLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async (args: any) => args.data) },
    productVendorHold: {
      create: jest.fn(async (args: any) => ({ id: 'hold-1', ...args.data })),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productVendor: { update: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn() },
    ...overrides,
  };
}

function makeService(siteSetting: any = null) {
  const prisma: any = { siteSetting: { findUnique: jest.fn().mockResolvedValue(siteSetting) } };
  const service = new ProductLedgerService(prisma);
  return { service, prisma };
}

describe('ProductLedgerService.postEntry', () => {
  it('locks the vendor row before reading the last balance, then inserts a signed entry', async () => {
    const { service } = makeService();
    const tx = makeTx({ productVendorLedgerEntry: { findFirst: jest.fn().mockResolvedValue({ balanceAfter: 100 }), create: jest.fn(async (a: any) => a.data) } });
    const entry = await service.postEntry(tx, 'vendor-1', 'COMMISSION', -20, { orderId: 'order-1' });
    expect(tx.$queryRaw).toHaveBeenCalled(); // FOR UPDATE row lock taken first
    expect(entry.balanceAfter).toBe(80);
    expect(entry.amount).toBe(-20);
  });

  it('starts a brand-new vendor at balance 0 when no prior entry exists', async () => {
    const { service } = makeService();
    const tx = makeTx();
    const entry = await service.postEntry(tx, 'vendor-1', 'GROSS_SALE', 500, { orderId: 'order-1' });
    expect(entry.balanceAfter).toBe(500);
  });
});

describe('ProductLedgerService.settleProductOrder', () => {
  const order = {
    id: 'order-1',
    productsAmount: 1000,
    productFeeBreakdown: {
      commission: { amount: 80, ruleId: 'r1', ruleLabel: 'Category rule: 8%' },
      marketing: { amount: 10, ruleId: null, ruleLabel: 'No rule — ₹0' },
      gateway: { amount: 5, ruleId: null, ruleLabel: 'No rule — ₹0' },
      gstOnFees: { amount: 17, ratePercent: 18 },
    },
    items: [{ vendorId: 'vendor-1', product: { returnWindowDays: 7 } }],
  };
  const shipment = { logisticsProviderId: 'lp-1', actualDeliveryCost: 55, deliveredAt: null };

  it('posts GROSS_SALE, every fee deduction, merges delivery into productFeeBreakdown, then HOLDs the net credit', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.settleProductOrder(tx, order as any, shipment as any, new Date('2026-08-29T00:00:00Z'));

    const types = tx.productVendorLedgerEntry.create.mock.calls.map((c: any) => c[0].data.type);
    expect(types).toEqual(['GROSS_SALE', 'COMMISSION', 'GST_ON_FEES', 'MARKETING_FEE', 'GATEWAY_FEE', 'DELIVERY_COST', 'HOLD']);

    const amounts = tx.productVendorLedgerEntry.create.mock.calls.map((c: any) => c[0].data.amount);
    expect(amounts).toEqual([1000, -80, -17, -10, -5, -55, -833]); // net = 1000-80-17-10-5-55 = 833

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { productFeeBreakdown: expect.objectContaining({ delivery: { amount: 55, logisticsProviderId: 'lp-1' } }) },
    });

    // totalEarnings gets the net credit immediately; pendingPayout is untouched here — it
    // only increments once the hold releases (ProductHoldSweepService below).
    expect(tx.productVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { totalEarnings: { increment: 833 } } });

    expect(tx.productVendorHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        vendorId: 'vendor-1', type: 'RETURN_WINDOW_HOLD', amount: 833, remaining: 833, orderId: 'order-1',
        releaseDueAt: new Date('2026-09-05T00:00:00Z'), // deliveredAt + 7 days (per-product override wins over SiteSetting)
      }),
    });
  });

  it('Phase 8: a GST-Included order posts GROSS_SALE at the back-derived taxable base, not the full inclusive productsAmount', async () => {
    const { service } = makeService();
    const tx = makeTx();
    // productsAmount=1180 (what the customer paid, tax-inclusive) but productsTaxableAmount
    // =1000 (the back-derived ex-GST base) — GROSS_SALE must use the latter.
    const inclusiveOrder = { ...order, productsAmount: 1180, productsTaxableAmount: 1000 };
    await service.settleProductOrder(tx, inclusiveOrder as any, shipment as any, new Date('2026-08-29T00:00:00Z'));
    const grossSaleEntry = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'GROSS_SALE')!;
    expect(grossSaleEntry[0].data.amount).toBe(1000);
  });

  it('Phase 8: a GST-Excluded order (no productsTaxableAmount, or equal to productsAmount) settles identically to before — no-op regression guard', async () => {
    const { service } = makeService();
    const tx = makeTx();
    const excludedOrder = { ...order, productsTaxableAmount: 1000 }; // same as productsAmount — genuinely excluded
    await service.settleProductOrder(tx, excludedOrder as any, shipment as any, new Date('2026-08-29T00:00:00Z'));
    const grossSaleEntry = tx.productVendorLedgerEntry.create.mock.calls.find((c: any) => c[0].data.type === 'GROSS_SALE')!;
    expect(grossSaleEntry[0].data.amount).toBe(1000); // identical to the original (no productsTaxableAmount) test above
  });

  it('falls back to the SiteSetting return-window default when the product has no override', async () => {
    const { service } = makeService({ value: '10' });
    const tx = makeTx();
    const orderNoOverride = { ...order, items: [{ vendorId: 'vendor-1', product: { returnWindowDays: null } }] };
    await service.settleProductOrder(tx, orderNoOverride as any, shipment as any, new Date('2026-08-29T00:00:00Z'));
    expect(tx.productVendorHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ releaseDueAt: new Date('2026-09-08T00:00:00Z') }), // +10 days
    });
  });

  it('skips zero-amount fee lines entirely (no COMMISSION entry when commission is 0)', async () => {
    const { service } = makeService();
    const tx = makeTx();
    const zeroFeeOrder = {
      ...order,
      productFeeBreakdown: { commission: { amount: 0 }, marketing: { amount: 0 }, gateway: { amount: 0 }, gstOnFees: { amount: 0 } },
    };
    await service.settleProductOrder(tx, zeroFeeOrder as any, { ...shipment, actualDeliveryCost: 0 } as any, new Date());
    const types = tx.productVendorLedgerEntry.create.mock.calls.map((c: any) => c[0].data.type);
    expect(types).toEqual(['GROSS_SALE', 'HOLD']);
  });
});

describe('ProductLedgerService.chargeUnsettledDeliveryCost', () => {
  it('posts a standalone DELIVERY_COST debit and decrements totalEarnings — no GROSS_SALE required', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.chargeUnsettledDeliveryCost(tx, 'order-1', 'vendor-1', 55);
    expect(tx.productVendorLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'DELIVERY_COST', amount: -55, orderId: 'order-1' }),
    }));
    expect(tx.productVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { totalEarnings: { decrement: 55 } } });
  });

  it('is a no-op for a zero or negative amount', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.chargeUnsettledDeliveryCost(tx, 'order-1', 'vendor-1', 0);
    expect(tx.productVendorLedgerEntry.create).not.toHaveBeenCalled();
  });
});

describe('ProductLedgerService.reverseSettlement — proportional reversal', () => {
  const settledOrder = {
    productsAmount: 1000,
    productFeeBreakdown: {
      commission: { amount: 80 }, marketing: { amount: 10 }, gateway: { amount: 5 }, gstOnFees: { amount: 17 },
      delivery: { amount: 55 },
    },
    items: [{ vendorId: 'vendor-1' }],
  };

  it('Phase 8: reverses the back-derived taxable base for a GST-Included order, not the full inclusive productsAmount', async () => {
    const { service } = makeService();
    const inclusiveOrder = { ...settledOrder, productsAmount: 1180, productsTaxableAmount: 1000 };
    const tx = makeTx({
      order: { findUnique: jest.fn().mockResolvedValue(inclusiveOrder) },
      productVendorHold: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await service.reverseSettlement(tx, 'order-1', 1, 'RETURN');
    const entries = tx.productVendorLedgerEntry.create.mock.calls.map((c: any) => c[0].data);
    expect(entries.find((e: any) => e.notes?.includes('Gross sale')).amount).toBe(-1000); // taxable base, not -1180
  });

  it('is a safe no-op when the order was never settled (e.g. RTO before delivery)', async () => {
    const { service } = makeService();
    const tx = makeTx({ order: { findUnique: jest.fn().mockResolvedValue({ productFeeBreakdown: null, productsAmount: 1000, items: [{ vendorId: 'vendor-1' }] }) } });
    await service.reverseSettlement(tx, 'order-1', 1, 'RTO');
    expect(tx.productVendorLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('reverses fee lines proportionally to the refunded fraction and deducts from an active HOLD first', async () => {
    const { service } = makeService();
    const tx = makeTx({
      order: { findUnique: jest.fn().mockResolvedValue(settledOrder) },
      productVendorHold: {
        findFirst: jest.fn().mockResolvedValue({ id: 'hold-1', remaining: 833 }),
        update: jest.fn(async (a: any) => a.data),
      },
    });
    // Half the order value refunded — every fee line reverses at 50%.
    await service.reverseSettlement(tx, 'order-1', 0.5, 'RETURN');

    const entries = tx.productVendorLedgerEntry.create.mock.calls.map((c: any) => c[0].data);
    expect(entries.find((e: any) => e.notes?.includes('Gross sale')).amount).toBe(-500);
    expect(entries.find((e: any) => e.notes?.includes('Commission')).amount).toBe(40);
    expect(entries.find((e: any) => e.notes?.includes('Delivery cost')).amount).toBe(27.5);
    expect(entries.every((e: any) => e.type === 'RETURN_ADJUSTMENT')).toBe(true);

    // netReversal = -500 + 40 + 8.5 + 5 + 2.5 + 27.5 = -416.5 (seller owes this much back)
    expect(tx.productVendorHold.update).toHaveBeenCalledWith({
      where: { id: 'hold-1' },
      data: expect.objectContaining({ remaining: 833 - 416.5 }),
    });
    expect(tx.productVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { totalEarnings: { increment: -416.5 } } });
  });

  it('fully forfeits the hold when a full reversal consumes all of it', async () => {
    const { service } = makeService();
    const tx = makeTx({
      order: { findUnique: jest.fn().mockResolvedValue(settledOrder) },
      productVendorHold: {
        findFirst: jest.fn().mockResolvedValue({ id: 'hold-1', remaining: 833 }),
        update: jest.fn(async (a: any) => a.data),
      },
    });
    await service.reverseSettlement(tx, 'order-1', 1, 'RETURN');
    expect(tx.productVendorHold.update).toHaveBeenCalledWith({
      where: { id: 'hold-1' },
      data: expect.objectContaining({ status: 'FORFEITED' }),
    });
  });

  it('debits the live pendingPayout balance directly when the hold has already released', async () => {
    const { service } = makeService();
    const tx = makeTx({
      order: { findUnique: jest.fn().mockResolvedValue(settledOrder) },
      productVendorHold: { findFirst: jest.fn().mockResolvedValue(null) }, // already RELEASED — no HELD row found
    });
    await service.reverseSettlement(tx, 'order-1', 1, 'RETURN');
    expect(tx.productVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { pendingPayout: { increment: -833 } } });
  });
});

describe('ProductHoldSweepService', () => {
  function makeSweep() {
    const ledger: any = { postEntry: jest.fn() };
    const prisma: any = {
      productVendorHold: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
      productVendor: { update: jest.fn() },
      $transaction: jest.fn((cb: any) => cb(prisma)),
    };
    const service = new ProductHoldSweepService(prisma, ledger);
    return { service, prisma, ledger };
  }

  it('releases every matured HELD hold into pendingPayout via a HOLD_RELEASE entry', async () => {
    const { service, prisma, ledger } = makeSweep();
    prisma.productVendorHold.findMany.mockResolvedValue([{ id: 'hold-1' }]);
    prisma.productVendorHold.findUnique.mockResolvedValue({ id: 'hold-1', vendorId: 'vendor-1', remaining: 833, orderId: 'order-1' });
    prisma.productVendorHold.updateMany.mockResolvedValue({ count: 1 });
    await service.sweep();
    expect(ledger.postEntry).toHaveBeenCalledWith(prisma, 'vendor-1', 'HOLD_RELEASE', 833, { orderId: 'order-1' });
    expect(prisma.productVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { pendingPayout: { increment: 833 } } });
  });

  it('is a safe no-op if another process already claimed the release (updateMany count 0)', async () => {
    const { service, prisma, ledger } = makeSweep();
    prisma.productVendorHold.findMany.mockResolvedValue([{ id: 'hold-1' }]);
    prisma.productVendorHold.findUnique.mockResolvedValue({ id: 'hold-1', vendorId: 'vendor-1', remaining: 833 });
    prisma.productVendorHold.updateMany.mockResolvedValue({ count: 0 });
    await service.sweep();
    expect(ledger.postEntry).not.toHaveBeenCalled();
  });
});
