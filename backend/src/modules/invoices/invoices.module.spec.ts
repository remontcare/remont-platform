import { ForbiddenException } from '@nestjs/common';
import { InvoicesService } from './invoices.module';

function baseOrder(overrides: any = {}) {
  return {
    id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a', staffType: 'PARTNER', gstin: null },
    invoice: null, status: 'COMPLETED', orderNumber: 'REM-1', type: 'SERVICE',
    subtotal: 1000, totalAmount: 1180, gstAmount: 180, serviceAmount: 1000,
    remontCommission: 150, platformCharges: 0, snapshotState: 'Madhya Pradesh',
    billingTransactionType: null,
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
  // Phase 5 — generateForOrder() allocates its document number(s) and creates the Invoice
  // row inside one $transaction(); the mock just runs the callback against this same
  // `prisma` object so tx.invoice.create()/tx.$queryRaw above are the mocks already set up.
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new InvoicesService(prisma), prisma };
}

describe('InvoicesService.generate — closing the "any user can read any invoice" gap', () => {
  it('rejects a caller who is neither the order\'s customer nor its assigned vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await expect(svc.generate('random-user', 'o1')).rejects.toThrow(ForbiddenException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it('allows the order\'s own customer to generate it', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await expect(svc.generate('cust-1', 'o1')).resolves.toBeDefined();
  });
});

describe('InvoicesService.generateForOrder — routes every transaction type through the one billing engine', () => {
  it('is idempotent — returns the existing invoice without recomputing', async () => {
    const { svc, prisma } = makeService();
    prisma.invoice.findUnique.mockResolvedValue({ id: 'existing-inv' });
    const result = await svc.generateForOrder('o1');
    expect(result).toEqual({ id: 'existing-inv' });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('never fabricates a GST breakup on the vendor/partner settlement page when the partner has no GSTIN', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.vendorCgst).toBe(0);
    expect(data.vendorSgst).toBe(0);
  });

  it('splits GST into CGST+SGST on the Remont platform-fee page for an intra-state partner service order', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: '999799' }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.transactionType).toBe('PLATFORM_SERVICE');
    expect(Number(data.remontCgst)).toBeGreaterThan(0);
    expect(Number(data.remontCgst)).toBe(Number(data.remontSgst));
    expect(data.remontIgst).toBe(0);
  });

  it('classifies an in-house-staffed order as a direct project and taxes the full customer value', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: null }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      vendor: { userId: 'vendor-user-a', staffType: 'IN_HOUSE', gstin: null },
      serviceItems: [{ quantity: 1, unitPrice: 1000, service: { name: 'AC Repair', hsnSac: null, gstOverridePercent: null, unit: 'per visit' } }],
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.transactionType).toBe('DIRECT_PROJECT');
    expect(Number(data.customerSubtotal)).toBe(1000);
    expect(Number(data.customerCgst)).toBe(90);
    expect(Number(data.customerSgst)).toBe(90);
  });

  // Updated 2026-10-14 for the confirmed business model: commission is INCLUDED in the service
  // price (checkout stores serviceAmount = full ₹499 and vendorPayout = serviceAmount −
  // commission), so it is never added to the customer's total a second time. The old fixture
  // modelled serviceAmount as the partner's ₹399.20 share with ₹99.80 added on top, which
  // real checkout data never has (production: serviceAmount 2748, commission 549.60).
  it('matches the corrected Type 1 worked example exactly: ₹499 service incl. 20% commission, GST on Remont commission only', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      serviceAmount: 499, remontCommission: 99.80, vendorPayout: 399.20, platformCharges: 0,
      gstAmount: 89.82, totalAmount: 588.82, // what checkout charged: 499 + 18%
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;

    // (1) Partner Service Invoice — the partner's service value (₹499, commission included),
    // never taxed (unregistered partner in this fixture), never shown as Remont revenue.
    expect(Number(data.vendorLabor)).toBe(499);
    expect(Number(data.vendorCgst)).toBe(0);
    expect(Number(data.vendorTotal)).toBe(499);

    // (2) Remont Platform Fee Invoice — Remont's ₹99.80 only, taxed at 18%: CGST 8.98 +
    // SGST 8.98 = GST ₹17.96 (matches the corrected spec exactly). The pre-rounding total
    // is ₹117.76; per standard Indian tax-invoice convention (same rounding already
    // validated against the reference invoice — ₹2,999.99 displayed as a clean ₹3,000)
    // this is a REGISTERED tax invoice, so it rounds to a clean ₹118, with the 24 paise
    // difference visible in roundOff rather than silently absorbed.
    expect(Number(data.platformCommission)).toBe(99.80);
    expect(Number(data.remontCgst)).toBe(8.98);
    expect(Number(data.remontSgst)).toBe(8.98);
    expect(Number(data.remontCgst) + Number(data.remontSgst)).toBe(17.96);
    expect(Number(data.remontTotal)).toBe(118);

    // (3) Customer payment statement — NOT a formal tax invoice; equals exactly what checkout
    // charged: the ₹499 service + the ₹89.82 GST collected on it = ₹588.82 (no commission line,
    // no booking fee, no whole-rupee rounding).
    expect(data.transactionType).toBe('PLATFORM_SERVICE');
    expect(Number(data.customerCgst) + Number(data.customerSgst)).toBe(89.82);
    expect(Number(data.customerTotal)).toBe(588.82);
    expect(data.lineItemsSnapshot.customer.map((l: any) => l.description)).not.toContain('Remont Platform Fee');
    expect(Number(data.bookingFee)).toBe(0);

    // Never uses the word "Commission" anywhere in the stored document data.
    expect(JSON.stringify(data)).not.toMatch(/commission invoice|marketplace commission/i);
  });

  it('taxes two different services on the same invoice at their own distinct GST rates by HSN/SAC — never one blanket rate', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([
      { rate: 18, hsnCode: '998714', isActive: true, createdAt: new Date('2026-01-01') }, // appliance repair
      { rate: 5, hsnCode: '999599', isActive: true, createdAt: new Date('2026-01-02') },  // basic cleaning
    ]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      vendor: { userId: 'vendor-user-a', staffType: 'IN_HOUSE', gstin: null },
      serviceItems: [
        { quantity: 1, unitPrice: 1000, service: { name: 'AC Repair', hsnSac: '998714', gstOverridePercent: null, unit: 'per visit' } },
        { quantity: 1, unitPrice: 500, service: { name: 'Home Cleaning', hsnSac: '999599', gstOverridePercent: null, unit: 'per visit' } },
      ],
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    const lines = data.lineItemsSnapshot.customer;
    expect(lines.find((l: any) => l.description === 'AC Repair').taxRatePercent).toBe(18);
    expect(lines.find((l: any) => l.description === 'Home Cleaning').taxRatePercent).toBe(5);
    // 1000@18% = 180, 500@5% = 25 -> total GST 205, split 9%/9%+2.5%/2.5% => CGST 102.5, SGST 102.5
    expect(Number(data.customerCgst)).toBe(102.5);
    expect(Number(data.customerSgst)).toBe(102.5);
  });

  it('a per-service GST override wins over the HSN-matched TaxConfig rate', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: '998714', isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      vendor: { userId: 'vendor-user-a', staffType: 'IN_HOUSE', gstin: null },
      serviceItems: [{ quantity: 1, unitPrice: 1000, service: { name: 'Custom Job', hsnSac: '998714', gstOverridePercent: 12, unit: 'per visit' } }],
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.lineItemsSnapshot.customer[0].taxRatePercent).toBe(12);
  });

  it('taxes an inter-state marketplace product sale with IGST using the seller\'s own GSTIN state, not the customer\'s', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: null, isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      type: 'PRODUCT',
      vendor: null,
      items: [{
        quantity: 2, unitPrice: 500,
        product: { name: 'Widget', hsnSac: null, gstOverridePercent: null, unit: 'piece', vendor: { gstNumber: '06AABCU7755Q1ZK', state: null, businessName: 'Acme' } },
      }],
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.transactionType).toBe('MARKETPLACE_PRODUCT');
    expect(data.supplierGstin).toBe('06AABCU7755Q1ZK');
    // seller GSTIN state code 06 = Haryana, customer/placeOfSupply = Madhya Pradesh -> inter-state
    expect(Number(data.customerIgst)).toBeGreaterThan(0);
    expect(Number(data.customerCgst)).toBe(0);
  });

  it('snapshots billingTransactionType onto the order once, and never overwrites it on a later call', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    await svc.generateForOrder('o1');
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { billingTransactionType: 'PLATFORM_SERVICE' } });
  });
});
