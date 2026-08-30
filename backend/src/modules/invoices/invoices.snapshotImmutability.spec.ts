import { InvoicesService } from './invoices.module';
import { buildInvoiceViewModel } from './invoice-pdf';

/**
 * Phase 4 (C-04/C-05) —
 *  C-04: a MARKETPLACE_PRODUCT invoice must price each line using the GST rate/price-type
 *  actually FROZEN on OrderItem at checkout (resolveProductGstLine(), Phase 8), not by
 *  re-resolving the Product's CURRENT tax config. Before this fix, an inclusive-priced
 *  item was always treated as EXCLUSIVE on the invoice (priceType was never even passed),
 *  double-taxing it; and any later admin edit to the product's HSN/rate/inclusive flag
 *  silently changed a past invoice's numbers.
 *  C-05: an issued invoice's party identity (name/address/GSTIN/state) must be frozen at
 *  generation time and never drift if the seller/customer/Remont's own master data is
 *  edited afterward.
 */

function baseOrder(overrides: any = {}) {
  return {
    id: 'o1', customerId: 'cust-1', vendor: null,
    invoice: null, orderNumber: 'REM-1', type: 'PRODUCT',
    subtotal: 1180, totalAmount: 1180, gstAmount: 0, serviceAmount: 0,
    remontCommission: 0, platformCharges: 0, snapshotState: 'Madhya Pradesh',
    billingTransactionType: null, couponDiscount: 0, membershipDiscount: 0, discountAllocation: null,
    service: null, serviceItems: [], extraWorkItems: [],
    items: [],
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

describe('C-04 — invoice must price OrderItem lines from the frozen GST snapshot, not live product data', () => {
  it('an INCLUSIVE item is never double-taxed — priceType is read from the frozen snapshot, not left to default EXCLUSIVE', async () => {
    const { svc, prisma } = makeService();
    // Frozen at checkout: 1180 gross, 18% inclusive => taxableValue 1000, gstAmount 180.
    // The LIVE product has since been re-tagged gstInclusive:false / a different HSN — if
    // the invoice re-derived live, it would add 18% on top of 1180 a second time.
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{
        quantity: 1, unitPrice: 1180, gstInclusive: true, gstRatePercent: 18, taxableValue: 1000, gstAmount: 180,
        product: { name: 'Widget', hsnSac: 'HSN-LIVE-CHANGED', gstOverridePercent: null, gstInclusive: false, categoryId: 'cat-1', unit: 'piece', vendor: null },
      }],
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.customerSubtotal)).toBe(1000); // back-derived from the FROZEN inclusive rate, not re-added
    expect(Number(data.customerCgst) + Number(data.customerSgst)).toBe(180);
    expect(Number(data.customerTotal)).toBe(1180); // matches what was actually charged — not 1180+212 double-taxed
  });

  it('a later admin edit to the product\'s GST rate/HSN never changes an already-generated invoice\'s numbers', async () => {
    const { svc, prisma } = makeService();
    const orderAtCheckoutTime = baseOrder({
      items: [{
        quantity: 1, unitPrice: 1000, gstInclusive: false, gstRatePercent: 12, taxableValue: 1000, gstAmount: 120,
        // Product row as it exists NOW (rate changed 12% -> 28%, HSN changed) — must be ignored.
        product: { name: 'Widget', hsnSac: 'HSN-NOW-28PCT', gstOverridePercent: 28, gstInclusive: null, categoryId: 'cat-1', unit: 'piece', vendor: null },
      }],
    });
    prisma.order.findUnique.mockResolvedValue(orderAtCheckoutTime);
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.customerCgst) + Number(data.customerSgst)).toBe(120); // 12% (frozen), not 28% (live/current)
  });

  it('a legacy OrderItem with no frozen snapshot (gstRatePercent null) falls back to live resolution — unchanged historical behaviour', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig.findMany.mockResolvedValue([{ rate: 18, hsnCode: 'HSN-X', appliesTo: ['PRODUCT'], priceType: 'GST_EXCLUSIVE', isActive: true, createdAt: new Date() }]);
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{
        quantity: 1, unitPrice: 1000, gstInclusive: null, gstRatePercent: null, taxableValue: null, gstAmount: null,
        product: { name: 'Legacy Widget', hsnSac: 'HSN-X', gstOverridePercent: null, gstInclusive: null, categoryId: 'cat-1', unit: 'piece', vendor: null },
      }],
    }));
    await svc.generateForOrder('o1');
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(Number(data.customerCgst) + Number(data.customerSgst)).toBe(180); // live-resolved 18%, exactly as before this fix
  });
});

describe('C-05 — issued invoice party identity is frozen at generation time', () => {
  it('re-rendering the SAME invoice after the seller/customer/company master data changes still shows the ORIGINAL party details', async () => {
    const { svc, prisma } = makeService();
    const originalOrder = baseOrder({
      items: [{
        quantity: 1, unitPrice: 1000, gstInclusive: false, gstRatePercent: 18, taxableValue: 1000, gstAmount: 180,
        product: {
          name: 'Widget', hsnSac: null, gstOverridePercent: null, gstInclusive: null, categoryId: 'cat-1', unit: 'piece',
          vendor: { businessName: 'Original Seller Pvt Ltd', address: 'Old Address, Bhopal', gstNumber: '23AAAAA0000A1Z5', state: 'Madhya Pradesh' },
        },
      }],
    });
    prisma.order.findUnique.mockResolvedValue(originalOrder);
    await svc.generateForOrder('o1');
    const storedData = prisma.invoice.create.mock.calls[0][0].data;
    expect(storedData.lineItemsSnapshot.parties.customer.supplier.name).toBe('Original Seller Pvt Ltd');

    // The seller has since rebranded/moved/re-registered, and Remont's own company config
    // changed too — re-rendering the PDF from the PERSISTED invoice row must still use the
    // party details captured at generation time, not these new ones.
    const mutatedOrder = {
      ...originalOrder,
      items: [{
        ...originalOrder.items[0],
        product: {
          ...originalOrder.items[0].product,
          vendor: { businessName: 'Renamed Seller LLP', address: 'New Address, Indore', gstNumber: '23BBBBB1111B2Z6', state: 'Madhya Pradesh' },
        },
      }],
    };
    const invoiceRow = { id: 'inv-1', ...storedData };
    const newCompany: any = { legalName: 'Remont NEW Legal Name', address: 'New HQ', mobile: '000', email: 'x@x.com', gstin: 'NEWGSTIN', state: 'Madhya Pradesh', bankName: '', bankIfsc: '', bankAccountNumber: '', invoiceTerms: [] };
    const vm = buildInvoiceViewModel(invoiceRow, 'CUSTOMER', { company: newCompany, order: mutatedOrder });

    expect(vm.supplier.name).toBe('Original Seller Pvt Ltd'); // frozen — not "Renamed Seller LLP"
    expect((vm.supplier as any).gstin).toBe('23AAAAA0000A1Z5'); // frozen — not the new GSTIN
  });

  it('a pre-existing invoice generated before this fix (no `parties` in lineItemsSnapshot) falls back to live derivation — never retroactively frozen', () => {
    const invoiceRow = {
      id: 'inv-old', invoiceNumber: 'INV-OLD-0001', generatedAt: new Date(), transactionType: 'MARKETPLACE_PRODUCT',
      customerSubtotal: 1000, customerCgst: 90, customerSgst: 90, customerIgst: 0, customerTotal: 1180, discount: 0, roundOff: 0,
      lineItemsSnapshot: { customer: [], vendor: [], remont: [] }, // no `parties` key at all
    };
    const order = {
      items: [{ product: { vendor: { businessName: 'Live Seller Now', address: 'Live Addr', gstNumber: 'LIVEGSTIN', state: 'Madhya Pradesh' } } }],
      snapshotState: 'Madhya Pradesh', customer: null, guestName: 'Guest',
    };
    const company: any = { legalName: 'Remont', address: '', mobile: '', email: '', gstin: '', state: 'Madhya Pradesh', bankName: '', bankIfsc: '', bankAccountNumber: '', invoiceTerms: [] };
    const vm = buildInvoiceViewModel(invoiceRow, 'CUSTOMER', { company, order });
    expect(vm.supplier.name).toBe('Live Seller Now'); // falls through to live — no snapshot to prefer
  });
});
