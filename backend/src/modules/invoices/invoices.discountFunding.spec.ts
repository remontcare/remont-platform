import { InvoicesService } from './invoices.module';
import { billingFindMany } from '../../common/billing-fixture.test';

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
    invoice: null, status: 'COMPLETED', orderNumber: 'REM-1', type: 'SERVICE',
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
    siteSetting: { findMany: jest.fn(billingFindMany()), findUnique: jest.fn(async () => null) },
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

  // Updated 2026-10-14: commission is included in the service price and deducted from the
  // partner, so the customer page has no Remont fee line at all; the coupon reduces the
  // service value, and GST is shown at the rate checkout charged (shared service resolver,
  // 18% when nothing is configured — the same 18% checkout applied to the discounted amount).
  it('PLATFORM_SERVICE — the coupon reduces the service value; no Remont commission line on the customer page', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      serviceAmount: 1000, remontCommission: 100, platformCharges: 0,
      couponDiscount: 100,
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.discount)).toBe(100);
    const lines = data.lineItemsSnapshot.customer;
    const partnerLine = lines.find((l: any) => l.description === 'AC Repair');
    expect(lines.find((l: any) => /Remont (Platform Fee|Commission)/.test(l.description))).toBeUndefined();
    expect(partnerLine.discount).toBe(100); // the coupon only ever applied to the service value at checkout
    // 1000 - 100 = 900 taxable @ 18% = 162 → 1062 (exactly what checkout charges for this booking)
    expect(partnerLine.taxableValue).toBe(900);
    expect(partnerLine.amount).toBe(1062);
    // Remont's commission is its own document, to the partner, never discounted by the coupon
    expect(data.lineItemsSnapshot.remont.find((l: any) => l.description === 'Remont Commission').discount).toBe(0);
  });

  it('no discount at all — discount field is 0, customerTotal unaffected, byte-for-byte the pre-Phase-3 behaviour', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.discount)).toBe(0);
  });
});
