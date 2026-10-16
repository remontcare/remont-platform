import { PrismaClient } from '@prisma/client';
import { InvoicesService } from './invoices.module';
import { buildInvoiceViewModel, buildCreditNoteViewModel } from './invoice-pdf';
import { PartnerLedgerService } from '../partner-ledger/partner-ledger.module';
import { OrdersService } from '../orders/orders.module';
import { getBillingCompanyConfig } from '../../common';

/**
 * Model 1 — external service partner: two separate documents per job (the partner's document to
 * the customer, Remont's commission invoice to the partner), against a THROWAWAY database
 * (INTEGRATION_DATABASE_URL; skipped otherwise). No network, no gateway, no money.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const d = url ? describe : describe.skip;
const pdfPages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
const COMPANY_GSTIN = '23AAKCR9036L1ZY';

d('Model 1 partner invoicing (throwaway Postgres)', () => {
  let prisma: PrismaClient;
  let invoices: InvoicesService;
  let orders: OrdersService;
  let seq = 0;
  const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
  const phone = () => `+91${6000000000 + Math.floor(Math.random() * 3999999999)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.$connect();
    invoices = new InvoicesService(prisma as any);
    const stub: any = {};
    orders = new OrdersService(prisma as any, stub, stub, stub, stub, stub, stub, stub, new PartnerLedgerService(prisma as any), invoices, stub);
    await getBillingCompanyConfig(prisma); // seeds the billing identity on a fresh database
    await setting('partner_invoice_issuance', null);
    await setting('partner_commission_gst_recovery', null);
  });
  afterAll(async () => {
    await setting('partner_invoice_issuance', null);
    await setting('partner_commission_gst_recovery', null);
    await prisma?.$disconnect();
  });

  async function setting(key: string, value: string | null) {
    if (value == null) await prisma.siteSetting.deleteMany({ where: { key } });
    else await prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value, group: 'test' } as any });
  }
  async function partner(gstin?: string, staffType = 'PARTNER') {
    const u = await prisma.user.create({ data: { phone: phone(), name: 'p' } });
    const v = await prisma.serviceVendor.create({ data: { userId: u.id, fullName: `Ravi ${seq}`, businessName: `Ravi Electricals ${seq}`, baseCity: 'Bhopal', staffType, gstin } as any });
    await prisma.partnerRegistration.create({ data: { registrationId: uniq('REG'), userId: u.id, phone: phone(), fullName: `Ravi ${seq}`, fullAddress: '12 MP Nagar', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462011', status: 'APPROVED', agreedTerms: true } as any });
    return v;
  }
  async function category(gstSection95Status: string | null = null) {
    return prisma.serviceCategory.create({ data: { key: uniq('C'), name: 'Electrical', icon: 'x', slug: uniq('c'), gstSection95Status } as any });
  }
  /** A paid, completed partner job. `gstPercent` is the service's own configured GST override. */
  async function job(vendor: any, cat: any, o: { amount?: number; commission?: number; gstPercent?: number; coupon?: number; extra?: Record<string, any> } = {}) {
    const amount = o.amount ?? 100, commission = o.commission ?? 20, coupon = o.coupon ?? 0;
    const gstPercent = o.gstPercent ?? 18;
    const customer = await prisma.user.create({ data: { phone: phone(), name: 'Asha Customer' } });
    const svc = await prisma.service.create({ data: { categoryId: cat.id, name: 'Fan installation', slug: uniq('s'), basePrice: amount, hsnSac: '998719', gstOverridePercent: gstPercent } as any });
    const gst = Math.round((amount - coupon) * gstPercent) / 100;
    const total = Math.round((amount - coupon + gst) * 100) / 100;
    return prisma.order.create({ data: {
      orderNumber: uniq('M1'), customerId: customer.id, type: 'SERVICE', serviceId: svc.id, vendorId: vendor.id, status: 'COMPLETED', paymentStatus: 'PAID',
      completedAt: new Date('2026-10-14T10:00:00Z'), snapshotState: 'Madhya Pradesh', snapshotAddressLine: '4 Arera Colony, Bhopal',
      serviceAmount: amount, subtotal: amount, couponDiscount: coupon, gstAmount: gst, totalAmount: total,
      remontCommission: commission, vendorPayout: amount - commission, commissionRuleLabel: 'Electrical 20%',
      serviceItems: { create: [{ serviceId: svc.id, quantity: 1, unitPrice: amount, totalPrice: amount }] }, ...(o.extra || {}),
    } as any });
  }
  async function views(orderId: string) {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId } });
    const order: any = await prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true, customer: true, masterOrder: true } });
    const company = await getBillingCompanyConfig(prisma);
    const vm = (k: 'CUSTOMER' | 'VENDOR' | 'REMONT') => buildInvoiceViewModel(inv, k, { company, order });
    return { inv, order, company, customer: vm('CUSTOMER'), partnerDoc: vm('VENDOR'), commission: vm('REMONT') };
  }

  it('1+3. partner document: the partner is the supplier, the customer the recipient; Remont is never the supplier', async () => {
    const v = await partner();
    const o = await job(v, await category());
    await invoices.generateForOrder(o.id);
    const { partnerDoc, inv } = await views(o.id);
    expect(partnerDoc.supplier.name).toBe(v.businessName);
    expect(partnerDoc.supplier.address).toBe('12 MP Nagar, Bhopal, 462011');
    expect(partnerDoc.supplier.state).toBe('Madhya Pradesh');
    expect(partnerDoc.supplier.gstin).toBeNull();
    expect(partnerDoc.supplier.gstin).not.toBe(COMPANY_GSTIN);
    expect(partnerDoc.recipient.name).toBe('Asha Customer');
    expect(partnerDoc.recipient.address).toBe('4 Arera Colony, Bhopal');
    expect(partnerDoc.referenceLine).toMatch(new RegExp(`Order ${o.orderNumber} · Service date 14/10/2026`));
    expect(partnerDoc.notes!.join(' ')).toMatch(/is not the supplier of this service/);
    expect(inv.vendorDocumentNumber).toMatch(/PSI/);
    // party identity frozen at issue: a later profile edit never changes the issued document
    await prisma.serviceVendor.update({ where: { id: v.id }, data: { businessName: 'Renamed later' } });
    expect((await views(o.id)).partnerDoc.supplier.name).toBe(v.businessName);
  });

  it('1+3. B2B customer: the customer GSTIN is printed on the partner document', async () => {
    const v = await partner('23ABCDE1234F1Z5');
    const customer = await prisma.user.create({ data: { phone: phone(), name: 'Biz' } });
    const mo = await prisma.masterOrder.create({ data: { masterOrderNumber: uniq('RM'), customerId: customer.id, customerGstin: '23AAACB1234C1Z9', customerGstName: 'Biz Pvt Ltd' } as any });
    const o = await job(v, await category(), { extra: { masterOrderId: mo.id, customerId: customer.id } });
    await invoices.generateForOrder(o.id);
    const { partnerDoc } = await views(o.id);
    expect(partnerDoc.recipient.name).toBe('Biz Pvt Ltd');
    expect(partnerDoc.recipient.gstin).toBe('23AAACB1234C1Z9');
    expect(partnerDoc.supplier.gstin).toBe('23ABCDE1234F1Z5');
  });

  it('2+3. commission invoice: separate number, Remont is the supplier, the partner the recipient, linked to the order and the partner document', async () => {
    const v = await partner();
    const o = await job(v, await category());
    await invoices.generateForOrder(o.id);
    const { inv, commission } = await views(o.id);
    expect(inv.remontDocumentNumber).toMatch(/PFI/);
    expect(new Set([inv.invoiceNumber, inv.vendorDocumentNumber, inv.remontDocumentNumber]).size).toBe(3);
    expect(commission.supplier.gstin).toBe(COMPANY_GSTIN);
    expect(commission.recipient.name).toBe(v.businessName);
    expect(commission.docBadge).toBe('TAX INVOICE');
    expect(commission.referenceLine).toBe(`Order ${o.orderNumber} · Partner document ${inv.vendorDocumentNumber}`);
    expect(commission.notes!.join(' ')).toMatch(/Commission on the service value of Rs\. 100\.00 \(Electrical 20%\): Rs\. 20\.00, plus GST at 18%/);
    // the customer never receives Remont's commission invoice to the partner
    expect(pdfPages(await invoices.getPdfBuffer(o.customerId, o.id, 'ALL'))).toBe(2);
    expect(pdfPages(await invoices.getPdfBuffer(v.userId, o.id, 'ALL'))).toBe(2);
    expect(pdfPages(await invoices.getPdfBufferAdmin(o.id, 'ALL'))).toBe(3);
  });

  it('4. the ₹100 / ₹80 / ₹20 / ₹3.60 example reconciles (unregistered partner, service GST configured at 0%)', async () => {
    const v = await partner();
    const o = await job(v, await category(), { amount: 100, commission: 20, gstPercent: 0 });
    await invoices.generateForOrder(o.id);
    const { inv, customer } = await views(o.id);
    // Invoice A: the full service value to the customer, no GST (partner unregistered)
    expect(Number(inv.vendorLabor)).toBe(100);
    expect(Number(inv.vendorCgst) + Number(inv.vendorSgst)).toBe(0);
    expect(Number(inv.vendorTotal)).toBe(100);
    // Invoice B: commission ₹20 + GST 18% ₹3.60 = ₹23.60, billed to the partner
    expect(Number(inv.platformCommission)).toBe(20);
    expect(Number(inv.remontCgst) + Number(inv.remontSgst) + Number(inv.remontIgst)).toBeCloseTo(3.6, 2);
    expect(Number(inv.remontTotal)).toBeCloseTo(23.6, 2);
    // what the customer paid equals the partner's document — commission is never charged twice
    expect(Number(inv.customerTotal)).toBe(100);
    expect(customer.total).toBe(Number(inv.vendorTotal));
    // partner payable + Remont commission = the service value
    const ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(Number(ord.vendorPayout) + Number(ord.remontCommission)).toBe(100);
  });

  it('5. registered partner: GST on what the customer was charged; malformed GSTIN never produces GST; tax invoice only with ON_BEHALF authority', async () => {
    // registered, ₹20 coupon → customer charged GST on ₹80; the partner document must agree
    const reg = await partner('23ABCDE1234F1Z5');
    const o = await job(reg, await category(), { coupon: 20 });
    await invoices.generateForOrder(o.id);
    let { inv, partnerDoc, customer } = await views(o.id);
    expect(Number(inv.vendorLabor)).toBe(80);
    expect(Number(inv.vendorCgst) + Number(inv.vendorSgst)).toBeCloseTo(14.4, 2);
    expect(Number(inv.vendorTotal)).toBeCloseTo(Number(inv.customerTotal), 2);
    expect(partnerDoc.isTaxInvoice).toBe(false); // default STATEMENT: Remont has no authority to issue it
    expect(partnerDoc.docBadge).toBe('PARTNER SERVICE STATEMENT — NOT A TAX INVOICE');
    expect(partnerDoc.notes!.join(' ')).toMatch(/issues its own tax invoice/);
    expect(partnerDoc.signatory).toMatch(/not signed on behalf of the partner/); // Remont never signs in the partner's name
    expect(customer.notes!.join(' ')).toMatch(/issues its own tax invoice/);

    // ON_BEHALF (set only after the partner agreement carries the authorisation) — frozen per invoice
    await setting('partner_invoice_issuance', 'ON_BEHALF');
    const o2 = await job(reg, await category());
    await invoices.generateForOrder(o2.id);
    ({ partnerDoc } = await views(o2.id));
    expect(partnerDoc.isTaxInvoice).toBe(true);
    expect(partnerDoc.docBadge).toBe('TAX INVOICE');
    expect(partnerDoc.copyTag).toMatch(/ON BEHALF OF THE PARTNER/);
    expect(partnerDoc.notes!.join(' ')).toMatch(/on behalf of .* under the partner's authorisation/);
    await setting('partner_invoice_issuance', null);
    expect((await views(o2.id)).partnerDoc.isTaxInvoice).toBe(true); // issued documents never change
    expect((await views(o.id)).partnerDoc.isTaxInvoice).toBe(false);

    // malformed GSTIN (valid state prefix only) = not registered: no GST, plain receipt
    const bad = await partner('23XYZ');
    const o3 = await job(bad, await category('NOT_APPLICABLE'));
    await invoices.generateForOrder(o3.id);
    ({ inv, partnerDoc } = await views(o3.id));
    expect(Number(inv.vendorCgst) + Number(inv.vendorSgst)).toBe(0);
    expect(partnerDoc.docBadge).toBe('PARTNER SERVICE RECEIPT — NO GST CHARGED');
    expect(partnerDoc.supplier.gstin).toBeNull();
    expect(inv.taxReviewRequired).toBe(true); // customer paid GST nobody is liable for → review
  });

  it('6. Section 9(5) only for an explicitly APPLICABLE category, only for an unregistered external partner', async () => {
    const unreg = await partner();
    const caReview = await invoices.generateForOrder((await job(unreg, await category(null))).id);
    expect(caReview.section95).toBe(false);
    expect(caReview.taxReviewRequired).toBe(true);
    const applicable = await invoices.generateForOrder((await job(unreg, await category('APPLICABLE'))).id);
    expect(applicable.section95).toBe(true);
    expect(applicable.supplierGstin).toBe(COMPANY_GSTIN);
    const registered = await invoices.generateForOrder((await job(await partner('23ABCDE1234F1Z5'), await category('APPLICABLE'))).id);
    expect(registered.section95).toBe(false);
  });

  it('7. in-house employee: one Remont tax invoice for the full amount; no partner document, no commission invoice', async () => {
    const tech = await partner(undefined, 'IN_HOUSE');
    const o = await job(tech, await category('APPLICABLE'), { commission: 0 });
    const inv = await invoices.generateForOrder(o.id);
    expect(inv.transactionType).toBe('DIRECT_PROJECT');
    expect(inv.section95).toBe(false);
    expect(inv.vendorDocumentNumber).toBeNull();
    expect(inv.remontDocumentNumber).toBeNull();
    expect(Number(inv.customerTotal)).toBe(118);
    expect((inv.lineItemsSnapshot as any).partnerDocument).toBeUndefined();
    expect(pdfPages(await invoices.getPdfBufferAdmin(o.id, 'ALL'))).toBe(1);
  });

  it('9. ledger: partner earnings post exactly once — gross, commission, optional commission GST — and reconcile to the documents', async () => {
    for (const recovery of [null, 'true']) {
      await setting('partner_commission_gst_recovery', recovery);
      const v = await partner();
      const o = await job(v, await category(), { gstPercent: 0, extra: { earningsStatus: 'DEFERRED' } });
      await prisma.paymentTransaction.create({ data: { orderId: o.id, userId: o.customerId, amount: 100, status: 'PAID', gateway: 'RAZORPAY', gatewayPaymentId: uniq('pay') } as any });
      await invoices.generateForOrder(o.id);
      const results = await Promise.all([orders.releaseJobEarnings(o.id), orders.releaseJobEarnings(o.id), orders.releaseJobEarnings(o.id)]);
      await orders.releaseJobEarnings(o.id); // a later retry
      expect(results.filter(Boolean).length).toBe(1);
      const entries = await prisma.partnerLedgerEntry.findMany({ where: { orderId: o.id } });
      const byType = (t: string) => entries.filter((e) => e.type === t).map((e) => Number(e.amount));
      expect(byType('JOB_EARNING')).toEqual([100]);
      expect(byType('COMMISSION')).toEqual([-20]);
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: o.id } });
      const commissionGst = Number(inv.remontCgst) + Number(inv.remontSgst) + Number(inv.remontIgst);
      expect(byType('GST')).toEqual(recovery ? [-commissionGst] : []);
      // warranty hold (a temporary retention, released later) is kept out of the reconciliation
      const isHold = (t: string) => /HOLD/.test(t);
      const net = entries.filter((e) => !isHold(e.type)).reduce((s, e) => s + Number(e.amount), 0);
      const held = entries.filter((e) => isHold(e.type)).reduce((s, e) => s + Number(e.amount), 0);
      // partner nets the service value minus what Remont's commission invoice recovers from them
      expect(net).toBeCloseTo(recovery ? 100 - Number(inv.remontTotal) : 100 - Number(inv.platformCommission), 2);
      const vendor = await prisma.serviceVendor.findUniqueOrThrow({ where: { id: v.id } });
      expect(Number(vendor.pendingPayout)).toBeCloseTo(net + held, 2);
    }
    await setting('partner_commission_gst_recovery', null);
  });

  it('10. retries and concurrent generation issue exactly one set of documents', async () => {
    const o = await job(await partner(), await category());
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => invoices.generateForOrder(o.id)));
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(ok.length).toBe(4);
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
    expect(await prisma.invoice.count({ where: { orderId: o.id } })).toBe(1);
    const again = await invoices.generateForOrder(o.id);
    expect(again.vendorDocumentNumber).toBe(ok[0].value.vendorDocumentNumber);
    expect(again.remontDocumentNumber).toBe(ok[0].value.remontDocumentNumber);
  });

  it('11. a refund is a credit note against the customer document; both issued Model 1 documents stay unchanged', async () => {
    const v = await partner();
    const o = await job(v, await category());
    const inv = await invoices.generateForOrder(o.id);
    const cn = await invoices.issueCreditNote(o.id, undefined, 59, 'part refund: fan regulator not fitted');
    expect(Number(cn!.totalReversed)).toBe(59);
    expect(cn!.originalInvoiceNumber).toBe(inv.invoiceNumber);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { orderId: o.id } });
    expect([after.vendorDocumentNumber, Number(after.vendorTotal), after.remontDocumentNumber, Number(after.remontTotal)])
      .toEqual([inv.vendorDocumentNumber, Number(inv.vendorTotal), inv.remontDocumentNumber, Number(inv.remontTotal)]);
    const { order, company } = await views(o.id);
    const note = buildCreditNoteViewModel(cn, after, { company, order });
    expect(note.docBadge).toBe('REFUND NOTE — NOT A GST CREDIT NOTE'); // against a booking summary
    expect(note.total).toBe(59);
    expect(pdfPages(await invoices.getPdfBuffer(o.customerId, o.id, 'ALL'))).toBe(3);
  });
});
