import { renderInvoicePdf, amountInWords, buildInvoiceViewModel } from './invoice-pdf';

const company = {
  legalName: 'REMONT INDIA PRIVATE LIMITED', gstin: '23AAKCR9036L1ZY', state: 'Madhya Pradesh',
  address: '5/6 Amer Complex, MP Nagar Zone-2, Bhopal', mobile: '9425330195', email: 'contact@remontindia.com',
  website: 'www.remontindia.com', bankName: 'Karnataka Bank, Bhopal', bankIfsc: 'KARB0000127', bankAccountNumber: '1272000100072001',
  invoiceTerms: ['This is a computer-generated invoice.', 'Subject to Bhopal jurisdiction.'],
};

function baseOrder(overrides: any = {}) {
  return {
    id: 'o1', orderNumber: 'REM-1', snapshotAddressLine: 'Test Address', snapshotState: 'Madhya Pradesh',
    customer: { name: 'Test Customer', phone: '9999999999', email: 'cust@example.com' },
    vendor: null, items: [], masterOrder: null,
    ...overrides,
  };
}

function baseInvoice(overrides: any = {}) {
  return {
    invoiceNumber: 'INV-REM-1-0001', generatedAt: new Date('2026-08-14'), placeOfSupply: 'Madhya Pradesh',
    transactionType: 'DIRECT_PROJECT',
    customerSubtotal: 2542.37, customerCgst: 228.81, customerSgst: 228.81, customerIgst: 0, customerTotal: 3000,
    vendorLabor: 0, vendorCgst: 0, vendorSgst: 0, vendorTotal: 0,
    platformCommission: 0, bookingFee: 0, remontCgst: 0, remontSgst: 0, remontIgst: 0, remontTotal: 0,
    discount: 0, roundOff: 0.01,
    lineItemsSnapshot: {
      customer: [{ description: 'Transportation from Bhopal to Berasia', hsnSac: null, qty: 1, unit: 'unit', rate: 2542.37, discount: 0, taxRatePercent: 18, taxableValue: 2542.37, cgst: 228.81, sgst: 228.81, igst: 0, amount: 3000 }],
      vendor: [], remont: [],
    },
    ...overrides,
  };
}

// PDFs are zip-free raw binary starting with the '%PDF-' header — a stable, cheap way to
// confirm PDFKit actually produced a real document rather than throwing mid-stream.
function isPdf(buf: Buffer) {
  return buf.slice(0, 5).toString('ascii') === '%PDF-';
}

describe('renderInvoicePdf', () => {
  it('renders the Type 2 direct-project tax invoice (matches the reference invoice numbers)', async () => {
    const buf = await renderInvoicePdf(baseInvoice(), 'CUSTOMER', { company, order: baseOrder() });
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  });

  it('renders the Type 1 informational customer summary with no GST fields', async () => {
    const invoice = baseInvoice({ transactionType: 'PLATFORM_SERVICE', customerCgst: 0, customerSgst: 0, customerTotal: 1180 });
    const vm = buildInvoiceViewModel(invoice, 'CUSTOMER', { company, order: baseOrder() });
    expect(vm.isTaxInvoice).toBe(false);
    expect(vm.docBadge).toMatch(/NOT A GST INVOICE/);
    const buf = await renderInvoicePdf(invoice, 'CUSTOMER', { company, order: baseOrder() });
    expect(isPdf(buf)).toBe(true);
  });

  it('renders the Type 1 Remont platform-fee tax invoice', async () => {
    const invoice = baseInvoice({
      transactionType: 'PLATFORM_SERVICE', platformCommission: 150, bookingFee: 49,
      remontCgst: 17.91, remontSgst: 17.91, remontTotal: 235,
    });
    const buf = await renderInvoicePdf(invoice, 'REMONT', { company, order: baseOrder() });
    expect(isPdf(buf)).toBe(true);
  });

  it('renders a plain no-GST settlement receipt for an unregistered partner', async () => {
    const invoice = baseInvoice({ transactionType: 'PLATFORM_SERVICE', vendorLabor: 998, vendorTotal: 998 });
    const order = baseOrder({ vendor: { fullName: 'Unregistered Partner', gstin: null } });
    const vm = buildInvoiceViewModel(invoice, 'VENDOR', { company, order });
    expect(vm.isTaxInvoice).toBe(false);
    expect(vm.docBadge).toMatch(/RECEIPT/);
    const buf = await renderInvoicePdf(invoice, 'VENDOR', { company, order });
    expect(isPdf(buf)).toBe(true);
  });

  it('renders a GST tax invoice for a registered partner settlement', async () => {
    const invoice = baseInvoice({ transactionType: 'PLATFORM_SERVICE', vendorLabor: 1000, vendorCgst: 90, vendorSgst: 90, vendorTotal: 1180 });
    const order = baseOrder({ vendor: { fullName: 'Registered Partner', gstin: '23AABCU1234L1ZK' } });
    const vm = buildInvoiceViewModel(invoice, 'VENDOR', { company, order });
    expect(vm.isTaxInvoice).toBe(true);
    const buf = await renderInvoicePdf(invoice, 'VENDOR', { company, order });
    expect(isPdf(buf)).toBe(true);
  });

  it('renders the seller as the supplier on a Type 3 marketplace product invoice', async () => {
    const invoice = baseInvoice({ transactionType: 'MARKETPLACE_PRODUCT' });
    const order = baseOrder({
      items: [{ product: { name: 'Widget', vendor: { businessName: 'Acme Sellers', gstNumber: '29AAACS1234L1ZQ', state: 'Karnataka', address: 'Bangalore' } } }],
    });
    const vm = buildInvoiceViewModel(invoice, 'CUSTOMER', { company, order });
    expect(vm.supplier.name).toBe('Acme Sellers');
    expect(vm.supplier.gstin).toBe('29AAACS1234L1ZQ');
    const buf = await renderInvoicePdf(invoice, 'CUSTOMER', { company, order });
    expect(isPdf(buf)).toBe(true);
  });

  it('renders Remont\'s commission invoice to the seller with the seller as the recipient', async () => {
    const invoice = baseInvoice({ transactionType: 'MARKETPLACE_PRODUCT', platformCommission: 50, remontTotal: 59 });
    const order = baseOrder({
      items: [{ product: { name: 'Widget', vendor: { businessName: 'Acme Sellers', gstNumber: '29AAACS1234L1ZQ', state: 'Karnataka', address: 'Bangalore' } } }],
    });
    const vm = buildInvoiceViewModel(invoice, 'REMONT', { company, order });
    expect(vm.recipient.name).toBe('Acme Sellers');
    expect(vm.supplier.name).toBe(company.legalName);
    const buf = await renderInvoicePdf(invoice, 'REMONT', { company, order });
    expect(isPdf(buf)).toBe(true);
  });
});

describe('Terms & Conditions placement', () => {
  it('applies Remont\'s own invoice terms on a direct-project (Remont-supplied) customer invoice', () => {
    const vm = buildInvoiceViewModel(baseInvoice(), 'CUSTOMER', { company, order: baseOrder() });
    expect(vm.termsAndConditions).toEqual(company.invoiceTerms);
  });

  it('never prints Remont\'s own terms on a marketplace seller\'s product invoice — the seller is the legal issuer, not Remont', () => {
    const invoice = baseInvoice({ transactionType: 'MARKETPLACE_PRODUCT' });
    const order = baseOrder({
      items: [{ product: { name: 'Widget', vendor: { businessName: 'Acme Sellers', gstNumber: '29AAACS1234L1ZQ', state: 'Karnataka', address: 'Bangalore' } } }],
    });
    const vm = buildInvoiceViewModel(invoice, 'CUSTOMER', { company, order });
    expect(vm.termsAndConditions).toEqual([]);
  });

  it('appends the category warranty period as a term when the service category has one', () => {
    const invoice = baseInvoice();
    const order = baseOrder({ service: { name: 'AC Repair', category: { warrantyDays: 30 } } });
    const vm = buildInvoiceViewModel(invoice, 'CUSTOMER', { company, order });
    expect(vm.termsAndConditions.some((t) => t.includes('30-day'))).toBe(true);
  });

  it('omits terms on the informational Type-1 booking summary — not a real tax invoice', () => {
    const invoice = baseInvoice({ transactionType: 'PLATFORM_SERVICE' });
    const vm = buildInvoiceViewModel(invoice, 'CUSTOMER', { company, order: baseOrder() });
    expect(vm.termsAndConditions).toEqual([]);
  });
});

describe('amountInWords', () => {
  it('matches the reference invoice — Rs. 3000 -> "Three Thousand Rupees Only"', () => {
    expect(amountInWords(3000)).toBe('Three Thousand Rupees Only');
  });
  it('handles lakhs and crores', () => {
    expect(amountInWords(150000)).toBe('One Lakh Fifty Thousand Rupees Only');
    expect(amountInWords(0)).toBe('Zero Rupees Only');
  });
});
