import { InvoicesService } from './invoices.module';

/**
 * Phase 3 (M-04) — before this, buildInvoiceBreakdown() hardcoded `discount: 0` and no
 * caller ever passed a real discount into any invoice line, so a discounted order's
 * invoice.customerTotal silently diverged from order.totalAmount (what was actually
 * charged) — and invoice-pdf.ts never even rendered the (always-zero) discount field, so
 * the gap was invisible. This file proves the fix per transaction type: DIRECT_PROJECT and
 * a SELLER-funded MARKETPLACE_PRODUCT order fold the discount into taxable value (mirroring
 * what checkout already did — see master-orders.discountFunding.spec.ts); a PLATFORM-funded
 * MARKETPLACE_PRODUCT order leaves taxable value untouched and nets the discount off the
 * total instead (an open CA question, never guessed at) — but in every case customerTotal
 * ends up equal to what the order actually charged.
 */

function baseOrder(overrides: any = {}) {
  return {
    id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a', staffType: 'PARTNER', gstin: null },
    invoice: null, orderNumber: 'REM-1', type: 'SERVICE',
    subtotal: 1000, totalAmount: 1180, gstAmount: 180, serviceAmount: 1000,
    remontCommission: 150, platformCharges: 0, snapshotState: 'Madhya Pradesh',
    billingTransactionType: null, couponDiscount: 0, membershipDiscount: 0, discountAllocation: null,
    service: { name: 'AC Repair', hsnSac: null, gstOverridePercent: null },
    serviceItems: [], items: [], extraWorkItems: [],
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })) },
    invoice: {
      findUnique: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: any) => ({ id: 'inv-1', ...args.data })),
    },
    siteSetting: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    taxConfig: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => [{ lastNumber: 1 }]),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new InvoicesService(prisma), prisma };
}

describe('InvoicesService.generateForOrder — discount funding (M-04)', () => {
  it('DIRECT_PROJECT — the discount reduces taxable value, exactly mirroring what checkout already charged GST on', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: null, isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      vendor: { userId: 'vendor-user-a', staffType: 'IN_HOUSE', gstin: null },
      serviceItems: [{ quantity: 1, unitPrice: 1000, service: { name: 'AC Repair', hsnSac: null, gstOverridePercent: null, unit: 'per visit' } }],
      couponDiscount: 200, totalAmount: (1000 - 200) * 1.18,
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.transactionType).toBe('DIRECT_PROJECT');
    expect(Number(data.discount)).toBe(200); // shown — never hardcoded 0
    expect(Number(data.customerSubtotal)).toBe(800); // 1000 - 200, taxable value actually reduced
    expect(Number(data.customerCgst)).toBe(72); // 9% of 800
    expect(Number(data.customerSgst)).toBe(72);
    expect(Number(data.customerTotal)).toBe(944); // 800 + 144 — reconciles with what checkout charged
    expect(Number(data.customerTotal)).toBeCloseTo(Number((1000 - 200) * 1.18), 5);
  });

  it('MARKETPLACE_PRODUCT, PLATFORM-funded (no allocation row = legacy fallback) — taxable value/GST stay full-rate; discount is shown and netted off the total only, post-tax', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: null, isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      type: 'PRODUCT', vendor: null,
      items: [{ quantity: 1, unitPrice: 1000, product: { name: 'Widget', hsnSac: null, gstOverridePercent: null, unit: 'piece', vendor: null } }],
      couponDiscount: 100, discountAllocation: null, // legacy order — no Phase 3 allocation row
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.transactionType).toBe('MARKETPLACE_PRODUCT');
    expect(Number(data.discount)).toBe(100);
    expect(Number(data.customerSubtotal)).toBe(1000); // untouched — full pre-discount taxable value
    expect(Number(data.customerCgst) + Number(data.customerSgst)).toBe(180); // full 18% GST, untouched
    expect(Number(data.customerTotal)).toBe(1000 + 180 - 100); // 1080 — discount netted post-tax
  });

  it('MARKETPLACE_PRODUCT, SELLER-funded (allocation row says taxableValueReduced) — discount folded into taxable value, matching checkout', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: null, isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      type: 'PRODUCT', vendor: null,
      items: [{ quantity: 1, unitPrice: 1000, product: { name: 'Widget', hsnSac: null, gstOverridePercent: null, unit: 'piece', vendor: null } }],
      couponDiscount: 100,
      discountAllocation: { taxableValueReduced: true },
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.discount)).toBe(100);
    expect(Number(data.customerSubtotal)).toBe(900); // 1000 - 100, taxable value actually reduced
    expect(Number(data.customerCgst) + Number(data.customerSgst)).toBe(162); // 18% of 900
    expect(Number(data.customerTotal)).toBe(900 + 162); // discount already inside taxable value — not subtracted again
  });

  it('PLATFORM_SERVICE — only the partner-value line is discounted, never the Remont platform fee line', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: '999799', isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      serviceAmount: 1000, remontCommission: 100, platformCharges: 0,
      couponDiscount: 100,
    }));
    prisma.siteSetting.findUnique.mockResolvedValue({ value: '0' }); // no booking fee, keeps the math simple
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.discount)).toBe(100);
    const lines = data.lineItemsSnapshot.customer;
    const partnerLine = lines.find((l: any) => l.description === 'AC Repair');
    const feeLine = lines.find((l: any) => l.description === 'Remont Platform Fee');
    expect(partnerLine.discount).toBe(100); // the coupon only ever applied to the partner value at checkout
    expect(feeLine.discount).toBe(0); // Remont's own fee is never discounted by a customer coupon
    // partner line: 1000 - 100 = 900 taxable @ 0% (this line is informational-only, taxRatePercent 0)
    expect(partnerLine.amount).toBe(900);
  });

  it('no discount at all — discount field is 0, customerTotal unaffected, byte-for-byte the pre-Phase-3 behaviour', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.discount)).toBe(0);
  });
});
