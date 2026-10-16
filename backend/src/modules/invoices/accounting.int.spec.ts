import { PrismaClient } from '@prisma/client';
import { InvoicesService } from './invoices.module';
import { buildInvoiceViewModel } from './invoice-pdf';
import { AccountingReportsService } from '../reports/accounting-reports';
import { PartnerLedgerService } from '../partner-ledger/partner-ledger.module';
import { OrdersService } from '../orders/orders.module';
import { gatewayFeeFromPayment } from '../payments/payments.module';
import { getBillingCompanyConfig, buildTaxRateResolver, resolveProductGstLine } from '../../common';

/**
 * REAL-DATABASE accounting checks — the real InvoicesService / reports / ledger against a THROWAWAY
 * database with this branch's schema pushed (INTEGRATION_DATABASE_URL; skipped otherwise). No
 * network, no payment gateway, no money. NEVER point this at production: it creates rows and
 * rewrites the 'billing' settings group.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const d = url ? describe : describe.skip;
const pdfPages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

d('Accounting & invoices (throwaway Postgres)', () => {
  let prisma: PrismaClient;
  let invoices: InvoicesService;
  let reports: AccountingReportsService;
  let admin: { id: string };
  let seq = 0;
  const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
  const phone = () => `+91${6000000000 + Math.floor(Math.random() * 3999999999)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    invoices = new InvoicesService(prisma as any);
    reports = new AccountingReportsService(prisma as any, new PartnerLedgerService(prisma as any));
    admin = await prisma.user.create({ data: { phone: phone(), name: 'int-super', role: 'SUPER_ADMIN' } as any });
    await prisma.siteSetting.deleteMany({ where: { group: 'billing' } });
    // rows from earlier runs on this throwaway database would make 'unconfigured' configured
    await prisma.taxConfig.updateMany({ where: { appliesTo: { has: 'PRODUCT' } }, data: { isActive: false } });
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  async function partner(gstin?: string, staffType = 'PARTNER') {
    const u = await prisma.user.create({ data: { phone: phone(), name: 'p' } });
    return prisma.serviceVendor.create({ data: { userId: u.id, fullName: `Partner ${seq}`, businessName: `Partner ${seq}`, baseCity: 'Bhopal', staffType, gstin } as any });
  }
  async function category(gstSection95Status: string | null = 'APPLICABLE') {
    return prisma.serviceCategory.create({ data: { key: uniq('C'), name: 'Electrical', icon: 'x', slug: uniq('c'), gstSection95Status } as any });
  }
  async function serviceOrder(vendor: any, cat: any, extra: Record<string, any> = {}) {
    const customer = await prisma.user.create({ data: { phone: phone(), name: 'Customer' } });
    const svc = await prisma.service.create({ data: { categoryId: cat.id, name: 'Switch repair', slug: uniq('s'), basePrice: 349, hsnSac: '998719' } as any });
    // ₹349 incl. ₹69.80 commission; 18% GST on the service → ₹411.82 paid
    return prisma.order.create({ data: {
      orderNumber: uniq('INT'), customerId: customer.id, type: 'SERVICE', serviceId: svc.id, vendorId: vendor.id, status: 'COMPLETED', paymentStatus: 'PAID',
      snapshotState: 'Madhya Pradesh', serviceAmount: 349, subtotal: 349, gstAmount: 62.82, totalAmount: 411.82, remontCommission: 69.8, vendorPayout: 279.2,
      serviceItems: { create: [{ serviceId: svc.id, quantity: 1, unitPrice: 349, totalPrice: 349 }] }, ...extra,
    } as any });
  }

  it('billing settings: migrated once from the legacy details, then read from saved settings; invalid identity is refused', async () => {
    const first = await getBillingCompanyConfig(prisma);
    expect(first.gstin).toBe('23AAKCR9036L1ZY');
    expect(first.state).toBe('Madhya Pradesh');
    expect(await prisma.siteSetting.count({ where: { group: 'billing' } })).toBe(10);
    await prisma.siteSetting.update({ where: { key: 'company_address' }, data: { value: 'New registered address, Bhopal' } });
    expect((await getBillingCompanyConfig(prisma)).address).toBe('New registered address, Bhopal');
    await prisma.siteSetting.update({ where: { key: 'company_gstin' }, data: { value: 'NOTAGSTIN' } });
    await expect(getBillingCompanyConfig(prisma)).rejects.toThrow(/not a valid GSTIN/);
    await prisma.siteSetting.update({ where: { key: 'company_gstin' }, data: { value: '' } });
    await expect(getBillingCompanyConfig(prisma)).rejects.toThrow(/incomplete \(company_gstin\)/);
    await prisma.siteSetting.update({ where: { key: 'company_gstin' }, data: { value: '23AAKCR9036L1ZY' } });
  });

  it('product GST: unconfigured is refused; an override or a TaxConfig row makes it sellable', async () => {
    const pcat = await prisma.productCategory.create({ data: { key: uniq('PC'), name: 'Fittings' } as any });
    const tax = await buildTaxRateResolver(prisma, 'PRODUCT');
    await expect(resolveProductGstLine(tax, { name: 'Bulb', hsnSac: null, gstOverridePercent: null, gstInclusive: false, categoryId: pcat.id } as any, 100)).rejects.toThrow(/Bulb.*not configured/);
    expect((await resolveProductGstLine(tax, { hsnSac: null, gstOverridePercent: 12, gstInclusive: false, categoryId: pcat.id }, 100)).gstAmount).toBe(12);
    await prisma.taxConfig.create({ data: { name: 'Fittings 18', type: 'GST', rate: 18, appliesTo: ['PRODUCT'], productCategoryId: pcat.id, isActive: true } as any });
    const tax2 = await buildTaxRateResolver(prisma, 'PRODUCT');
    expect((await resolveProductGstLine(tax2, { hsnSac: null, gstOverridePercent: null, gstInclusive: false, categoryId: pcat.id }, 100)).ratePercent).toBe(18);
    // another category's row never configures this one
    const other = await prisma.productCategory.create({ data: { key: uniq('PC'), name: 'Other' } as any });
    await expect(resolveProductGstLine(tax2, { name: 'Fan', hsnSac: null, gstOverridePercent: null, gstInclusive: false, categoryId: other.id } as any, 100)).rejects.toThrow(/Fan.*not configured/);
  });

  it('section 9(5): unregistered partner in an eligible category → the customer document is Remont\'s tax invoice', async () => {
    const o = await serviceOrder(await partner(), await category('APPLICABLE'));
    const inv = await invoices.generateForOrder(o.id);
    expect(inv.section95).toBe(true);
    expect(inv.taxReviewRequired).toBe(false);
    expect(inv.supplierGstin).toBe('23AAKCR9036L1ZY');
    expect(Number(inv.customerTotal)).toBeCloseTo(411.82, 2);
    const order = await prisma.order.findUnique({ where: { id: o.id }, include: { vendor: true, customer: true } });
    const company = await getBillingCompanyConfig(prisma);
    const vm = buildInvoiceViewModel(inv, 'CUSTOMER', { company, order });
    expect(vm.docBadge).toBe('TAX INVOICE');
    expect(vm.isTaxInvoice).toBe(true);
    expect(vm.supplier.gstin).toBe('23AAKCR9036L1ZY');
    expect(vm.notes!.join(' ')).toMatch(/section 9\(5\)/);
    expect(buildInvoiceViewModel(inv, 'VENDOR', { company, order }).notes!.join(' ')).toMatch(/charges no GST/);
  });

  it('registered partner → booking summary whose note names the partner\'s own tax invoice (no misleading platform-fee claim)', async () => {
    const o = await serviceOrder(await partner('23ABCDE1234F1Z5'), await category('APPLICABLE'));
    const inv = await invoices.generateForOrder(o.id);
    expect(inv.section95).toBe(false);
    const order = await prisma.order.findUnique({ where: { id: o.id }, include: { vendor: true, customer: true } });
    const vm = buildInvoiceViewModel(inv, 'CUSTOMER', { company: await getBillingCompanyConfig(prisma), order });
    expect(vm.docBadge).toMatch(/NOT A GST INVOICE/);
    expect(vm.notes!.join(' ')).toMatch(/23ABCDE1234F1Z5/);
    expect(vm.notes!.join(' ')).not.toMatch(/applies only to the Remont Platform Fee/);
  });

  it('unregistered partner in a category NOT under 9(5) → flagged for tax review', async () => {
    const inv = await invoices.generateForOrder((await serviceOrder(await partner(), await category('NOT_APPLICABLE'))).id);
    expect(inv.section95).toBe(false);
    expect(inv.taxReviewRequired).toBe(true);
  });

  it('a category is NOT under 9(5) unless set APPLICABLE (default = CA review required)', async () => {
    const cat = await prisma.serviceCategory.create({ data: { key: uniq('C'), name: 'Painting', icon: 'x', slug: uniq('c'), section95Applicable: true } as any });
    expect(cat.gstSection95Status).toBeNull(); // the retired flag has no effect
    const inv = await invoices.generateForOrder((await serviceOrder(await partner(), cat)).id);
    expect(inv.section95).toBe(false);
    expect(inv.taxReviewRequired).toBe(true);
  });

  it('in-house employee: never 9(5), GST on the full service amount, Remont is the supplier — even with an old PLATFORM_SERVICE snapshot', async () => {
    const tech = await partner(undefined, 'IN_HOUSE');
    const fresh = await invoices.generateForOrder((await serviceOrder(tech, await category('APPLICABLE'))).id);
    expect(fresh.transactionType).toBe('DIRECT_PROJECT');
    expect(fresh.section95).toBe(false);
    expect(Number(fresh.customerSubtotal)).toBe(349);
    expect(Number(fresh.customerCgst) + Number(fresh.customerSgst)).toBeCloseTo(62.82, 2);
    expect(fresh.supplierGstin).toBe('23AAKCR9036L1ZY');
    const stale = await invoices.generateForOrder((await serviceOrder(tech, await category('APPLICABLE'), { billingTransactionType: 'PLATFORM_SERVICE' })).id);
    expect(stale.section95).toBe(false);
  });

  it('PDFs: combined admin PDF has every document + credit notes; the customer gets only theirs; credit-note PDF renders; received amount is the real payment', async () => {
    const vendor = await partner();
    const o = await serviceOrder(vendor, await category('APPLICABLE'));
    await invoices.generateForOrder(o.id);
    await prisma.paymentTransaction.create({ data: { orderId: o.id, userId: o.customerId, amount: 411.82, status: 'PAID', gateway: 'RAZORPAY', gatewayPaymentId: 'pay_INT123' } as any });
    const cn = await invoices.issueCreditNote(o.id, undefined, 100, 'partial refund');
    expect(cn!.originalInvoiceNumber).toBeTruthy();
    const all = await invoices.getPdfBufferAdmin(o.id, 'ALL');
    expect(all.slice(0, 4).toString()).toBe('%PDF');
    expect(pdfPages(all)).toBe(4); // customer, partner, Remont commission, credit note
    expect(pdfPages(await invoices.getPdfBuffer(o.customerId, o.id, 'ALL'))).toBe(3); // customer, partner, credit note
    expect(pdfPages(await invoices.getPdfBuffer(vendor.userId, o.id, 'ALL'))).toBe(2); // partner, Remont commission
    const { buffer } = await invoices.getCreditNotePdf(o.customerId, cn!.id);
    expect(buffer.slice(0, 4).toString()).toBe('%PDF');
    const stranger = await prisma.user.create({ data: { phone: phone(), name: 'x' } });
    await expect(invoices.getCreditNotePdf(stranger.id, cn!.id)).rejects.toThrow();
    const order = await prisma.order.findUnique({ where: { id: o.id } });
    const pay = await invoices.paymentInfoFor(order, 411.82);
    expect(pay.received).toBe(411.82);
    expect(pay.reference).toMatch(/Razorpay pay_INT123/);
  });

  it('reissue: issued invoice archived, cancelled by credit note, corrected invoice under new numbers, refunds carried, audited; stale/concurrent reissue refused', async () => {
    const o = await serviceOrder(await partner(), await category('APPLICABLE'));
    const original = await invoices.generateForOrder(o.id);
    // simulate a pre-fix invoice: issued as a booking summary although 9(5) applied
    await prisma.invoice.update({ where: { id: original.id }, data: { section95: false, supplierGstin: null } });
    await invoices.issueCreditNote(o.id, undefined, 50, 'refund before correction');

    const preview = await invoices.reissuePreview(o.id);
    expect(preview.changes).toContain('section95');
    expect(preview.correctedMatchesPaid).toBe(true);
    expect(await prisma.invoiceVersion.count({ where: { invoiceId: original.id } })).toBe(0); // preview writes nothing

    await expect(invoices.reissue({ sub: admin.id, role: 'SUPER_ADMIN' as any }, o.id, 'short')).rejects.toThrow(/reason/);
    const [a, b] = await Promise.allSettled([
      invoices.reissue({ sub: admin.id, role: 'SUPER_ADMIN' as any }, o.id, 'Section 9(5) applies — reissue as Remont tax invoice', 1),
      invoices.reissue({ sub: admin.id, role: 'SUPER_ADMIN' as any }, o.id, 'Section 9(5) applies — reissue as Remont tax invoice', 1),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const r: any = a.status === 'fulfilled' ? a.value : (b as any).value;

    const now = await prisma.invoice.findUnique({ where: { id: original.id }, include: { versions: true, creditNotes: true } });
    expect(now!.version).toBe(2);
    expect(now!.section95).toBe(true);
    expect(now!.invoiceNumber).not.toBe(original.invoiceNumber);
    expect(now!.versions).toHaveLength(1);
    expect(now!.versions[0].invoiceNumber).toBe(original.invoiceNumber);
    expect((now!.versions[0].snapshot as any).section95).toBe(false); // archived exactly as issued
    const cancel = now!.creditNotes.find((c) => c.kind === 'INVOICE_CANCELLATION')!;
    expect(Number(cancel.totalReversed)).toBeCloseTo(411.82 - 50, 2); // remaining value of the issued invoice
    expect(cancel.originalInvoiceNumber).toBe(original.invoiceNumber);
    const carried = now!.creditNotes.filter((c) => c.kind === 'REFUND' && c.originalInvoiceNumber === now!.invoiceNumber);
    expect(carried).toHaveLength(1);
    expect(Number(carried[0].totalReversed)).toBe(50);
    // net position: issued 411.82 − 50 − 361.82 = 0; corrected 411.82 − 50 = what was kept
    expect(r.carriedCreditNotes).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'INVOICE_REISSUED', targetId: original.id } })).toBe(1);
    await expect(invoices.reissue({ sub: admin.id, role: 'SUPER_ADMIN' as any }, o.id, 'Stale preview version reissue attempt', 1)).rejects.toThrow(/changed since the preview/);
    const h = await invoices.history(o.id);
    expect(h.versions).toHaveLength(1);
    expect(h.creditNotes.length).toBe(3);
  });

  it('product invoices are issued automatically; an ineligible order is flagged for retry instead', async () => {
    const customer = await prisma.user.create({ data: { phone: phone(), name: 'Buyer' } });
    const pcat = await prisma.productCategory.create({ data: { key: uniq('PC'), name: 'Lamps' } as any });
    const p = await prisma.product.create({ data: { categoryId: pcat.id, name: 'Lamp', slug: uniq('p'), sku: uniq('SKU'), price: 1000, gstOverridePercent: 18, gstInclusive: false } as any });
    const mk = (stage: string) => prisma.order.create({ data: {
      orderNumber: uniq('PRD'), customerId: customer.id, type: 'PRODUCT', status: 'CONFIRMED', paymentStatus: 'PAID', snapshotState: 'Madhya Pradesh', productFulfillmentStage: stage,
      productsAmount: 1000, subtotal: 1000, gstAmount: 180, totalAmount: 1180, items: { create: [{ productId: p.id, quantity: 1, unitPrice: 1000, totalPrice: 1000, gstRatePercent: 18, gstInclusive: false }] },
    } as any });
    const ok = await mk('HANDED_TO_LOGISTICS');
    await invoices.autoIssueProductInvoice(ok.id);
    const inv = await prisma.invoice.findUnique({ where: { orderId: ok.id } });
    expect(Number(inv!.customerTotal)).toBe(1180);
    // products follow the marketplace rules — never a service section 9(5) supply
    expect(inv!.transactionType).toBe('MARKETPLACE_PRODUCT');
    expect(inv!.section95).toBe(false);
    expect(inv!.taxReviewRequired).toBe(false);
    await invoices.autoIssueProductInvoice(ok.id); // idempotent
    expect(await prisma.invoice.count({ where: { orderId: ok.id } })).toBe(1);
    const early = await mk('AWAITING_SELLER');
    await invoices.autoIssueProductInvoice(early.id);
    expect((await prisma.order.findUnique({ where: { id: early.id } }))!.invoiceGenerationFailed).toBe(true);
  });

  it('reports: workbooks build from real rows; 9(5) supplies land in the ECO bucket; test-gateway orders are excluded', async () => {
    const o = await serviceOrder(await partner(), await category('APPLICABLE'));
    await invoices.generateForOrder(o.id);
    const t = await serviceOrder(await partner(), await category('APPLICABLE'));
    await invoices.generateForOrder(t.id);
    await prisma.paymentTransaction.create({ data: { orderId: t.id, userId: t.customerId, amount: 411.82, status: 'PAID', gateway: 'DEV_MOCK' } as any });
    expect((await reports.testOrderIds([o.id, t.id])).has(t.id)).toBe(true);
    expect((await reports.testOrderIds([o.id, t.id])).has(o.id)).toBe(false);
    const rows = await reports.documentRows({});
    expect(rows.some((r) => r.orderId === t.id && r.testOrder)).toBe(true);
    const s = await reports.gstSummaryData({});
    const eco = s.gstr3b['3.1.1(i) supplies on which Remont as ECO pays tax u/s 9(5) (net of credit notes)'];
    expect(eco.taxable).toBeGreaterThan(0);
    expect(s.note).toMatch(/NOT a filed return/);
    for (const fn of ['salesRegister', 'purchaseRegister', 'gstr1', 'gstr3b', 'gstPayable', 'revenueReport', 'profitability', 'refundsReport', 'settlementsReport', 'gatewayFeesReport'] as const) {
      const buf: Buffer = await (reports as any)[fn]({});
      expect(buf.slice(0, 2).toString()).toBe('PK'); // xlsx (zip)
    }
    expect((await reports.testPayments()).summary.paidCount).toBeGreaterThan(0);
  });

  it('partner payout reconciliation: an unposted pre-ledger job explains the gap; correction needs the reviewed figure, posts ADJUSTMENT only, audited', async () => {
    const v = await partner();
    await prisma.serviceVendor.update({ where: { id: v.id }, data: { pendingPayout: 2144.29 } });
    await prisma.partnerLedgerEntry.create({ data: { vendorId: v.id, type: 'TOP_UP', amount: 20.14, balanceAfter: 20.14 } as any });
    const job = await serviceOrder(v, await category('APPLICABLE'), { vendorPayout: 2124.15 });
    const rec = (await reports.partnerPayoutReconciliation()).vendors.find((x: any) => x.vendorId === v.id)!;
    expect(rec.difference).toBe(2124.15);
    expect(rec.unpostedJobs.map((j: any) => j.orderId)).toEqual([job.id]);
    expect(rec.unexplained).toBe(0);
    const actor = { sub: admin.id, role: 'SUPER_ADMIN' as any };
    await expect(reports.correctPartnerLedger(actor, v.id, { amount: 2124.15, expectedDifference: 2000, reason: 'Post job that predates ledger' })).rejects.toThrow(/review the reconciliation/);
    await expect(reports.correctPartnerLedger(actor, v.id, { amount: 3000, expectedDifference: 2124.15, reason: 'Post job that predates ledger' })).rejects.toThrow(/not exceed/);
    const r = await reports.correctPartnerLedger(actor, v.id, { amount: 2124.15, expectedDifference: 2124.15, reason: 'Post job that predates ledger', orderId: job.id });
    expect(r.differenceAfter).toBe(0);
    expect(Number((await prisma.serviceVendor.findUnique({ where: { id: v.id } }))!.pendingPayout)).toBe(2144.29); // payout untouched
    expect(await prisma.auditLog.count({ where: { action: 'PARTNER_LEDGER_RECONCILIATION_ADJUSTMENT', targetId: v.id } })).toBe(1);
    expect((await reports.partnerPayoutReconciliation()).vendors.find((x: any) => x.vendorId === v.id)).toBeUndefined();
  });

  it('in-house technician completing a job: no partner earnings, payout, hold or ledger entries (no double counting)', async () => {
    const tech = await partner(undefined, 'IN_HOUSE');
    const o = await serviceOrder(tech, await category('APPLICABLE'), { status: 'IN_PROGRESS', endOtp: '4321' });
    const stub: any = {};
    const orders = new OrdersService(prisma as any, stub, stub, stub, stub, stub, stub, stub, new PartnerLedgerService(prisma as any), invoices, stub);
    await orders.complete(tech.userId, o.id, '4321', []);
    const v = await prisma.serviceVendor.findUnique({ where: { id: tech.id } });
    expect(Number(v!.pendingPayout)).toBe(0);
    expect(Number(v!.totalEarnings)).toBe(0);
    expect(v!.completedJobs).toBe(1);
    expect(await prisma.partnerLedgerEntry.count({ where: { vendorId: tech.id } })).toBe(0);
    expect((await prisma.order.findUnique({ where: { id: o.id } }))!.status).not.toBe('IN_PROGRESS');
  });

  it('purchases: validated; ITC only with a supplier GSTIN', async () => {
    await expect(reports.createPurchase(admin.id, { supplierName: 'X', invoiceNumber: '1', invoiceDate: '2026-10-01', taxableValue: 100, cgst: 9, sgst: 9, igst: 18 })).rejects.toThrow(/either IGST or CGST/);
    await expect(reports.createPurchase(admin.id, { supplierName: 'X', supplierGstin: 'BAD', invoiceNumber: '1', invoiceDate: '2026-10-01', taxableValue: 100 })).rejects.toThrow(/GSTIN/);
    const ok = await reports.createPurchase(admin.id, { supplierName: 'Office Supplies', supplierGstin: '23ABCDE1234F1Z5', invoiceNumber: 'B-1', invoiceDate: '2026-10-01', taxableValue: 1000, cgst: 90, sgst: 90 });
    expect(ok.itcEligible).toBe(true);
    expect(Number(ok.totalValue)).toBe(1180);
    const noGstin = await reports.createPurchase(admin.id, { supplierName: 'Local shop', invoiceNumber: 'B-2', invoiceDate: '2026-10-01', taxableValue: 500 });
    expect(noGstin.itcEligible).toBe(false);
  });

  it('gateway fee: Razorpay fee (incl. GST) is split into net fee and its GST; absent data is never guessed', () => {
    expect(gatewayFeeFromPayment({ fee: 2360, tax: 360 })).toEqual({ gatewayFee: 20, gatewayFeeTax: 3.6 });
    expect(gatewayFeeFromPayment({ fee: null })).toEqual({});
    expect(gatewayFeeFromPayment({})).toEqual({});
  });
});
