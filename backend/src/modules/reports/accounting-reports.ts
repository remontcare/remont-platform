import { Injectable, Controller, Get, Post, Body, Param, Query, Res, UseGuards, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import Excel from 'exceljs';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import {
  JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, getBillingCompanyConfig, isValidGstinFormat, stateFromGstin, logAudit,
} from '../../common';
import { PartnerLedgerService } from '../partner-ledger/partner-ledger.module';

// ═══════════════════════════════════════════════════════════════════════════
// Accounting & GST reports — every figure is read from issued documents (Invoice,
// CreditNote), real payment rows, refunds, ledgers and admin-entered purchases. Nothing
// is recalculated or estimated. GSTR-1 / GSTR-3B outputs are RECONCILIATION AIDS for the
// accountant — this system does not file returns and never says it did.
// Payments through test gateways (DEV_MOCK / RAZORPAY_DEV) are never counted as money
// received; orders paid only through them are excluded and listed on their own.
// ═══════════════════════════════════════════════════════════════════════════

export const TEST_GATEWAYS = ['DEV_MOCK', 'RAZORPAY_DEV'];
const NOT_FILED = 'Reconciliation aid prepared from Remont India records — NOT a filed return. Verify with your CA before filing.';
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const n = (v: any) => (v == null ? 0 : Number(v));
const d = (v: any) => (v ? new Date(v).toLocaleDateString('en-IN') : '');
const month = (v: any) => { const x = new Date(v); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; };

export interface DateRange { from?: Date; to?: Date }
export function parseRange(from?: string, to?: string): DateRange {
  const f = from ? new Date(from) : undefined;
  const t = to ? new Date(new Date(to).getTime() + 86_400_000 - 1) : undefined;
  if ((f && isNaN(f.getTime())) || (t && isNaN(t.getTime()))) throw new BadRequestException('Invalid date range');
  return { from: f, to: t };
}
function within(range: DateRange) {
  if (!range.from && !range.to) return undefined;
  return { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) };
}

/** One outward document (or a credit note against one), as the registers see it. */
export interface DocRow {
  docNo: string; date: Date; docType: string; orderId: string; orderNumber: string; transactionType: string;
  supplierName: string; supplierGstin: string; remontIsSupplier: boolean; isTaxDocument: boolean;
  recipientName: string; recipientGstin: string; placeOfSupply: string; interState: boolean;
  section95: boolean; taxable: number; cgst: number; sgst: number; igst: number; total: number;
  lines: { hsnSac: string; description: string; qty: number; rate: number; taxable: number; cgst: number; sgst: number; igst: number }[];
  isCreditNote: boolean; againstDoc?: string; testOrder: boolean; review: string;
}

function addSheet(wb: Excel.Workbook, name: string, cols: [string, string, number?][], rows: any[], note?: string) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width: width || 16 }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  if (note) { ws.addRow({}); ws.addRow({ [cols[0][1]]: note }); }
  return ws;
}
async function toBuffer(wb: Excel.Workbook) { return Buffer.from(await wb.xlsx.writeBuffer()); }

@Injectable()
export class AccountingReportsService {
  constructor(private prisma: PrismaService, private ledger: PartnerLedgerService) {}

  // ─── shared loaders ───────────────────────────────────────────────────────

  /** Order ids whose only PAID payments are through test gateways (no real money). */
  async testOrderIds(orderIds: string[], masterIds: string[] = []): Promise<Set<string>> {
    if (!orderIds.length) return new Set();
    const pays = await this.prisma.paymentTransaction.findMany({
      // cart payments are stored with orderId = MasterOrder.id (masterOrderId set on newer rows)
      where: { status: 'PAID', isWalletTopup: false, refundRequestId: null, OR: [{ orderId: { in: orderIds } }, ...(masterIds.length ? [{ masterOrderId: { in: masterIds } }, { orderId: { in: masterIds } }] : [])] },
      select: { orderId: true, masterOrderId: true, gateway: true },
    });
    const real = new Set<string>(); const test = new Set<string>();
    for (const p of pays) {
      for (const key of [p.orderId, p.masterOrderId].filter(Boolean) as string[]) (TEST_GATEWAYS.includes(p.gateway) ? test : real).add(key);
    }
    const orders = await this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, masterOrderId: true } });
    const out = new Set<string>();
    for (const o of orders) {
      const keys = [o.id, o.masterOrderId].filter(Boolean) as string[];
      if (keys.some((k) => test.has(k)) && !keys.some((k) => real.has(k))) out.add(o.id);
    }
    return out;
  }

  /** Every issued document page and credit note in the range, with supplier/recipient as frozen at issue. */
  async documentRows(range: DateRange): Promise<DocRow[]> {
    const company = await getBillingCompanyConfig(this.prisma);
    const invoices = await this.prisma.invoice.findMany({
      where: { generatedAt: within(range) },
      include: { order: { include: { customer: { select: { name: true } }, vendor: true, masterOrder: true, items: { include: { product: { include: { vendor: true } } } } } } },
      orderBy: { generatedAt: 'asc' },
    });
    const notes = await this.prisma.creditNote.findMany({
      where: { issuedAt: within(range) },
      include: { invoice: { include: { order: { include: { customer: { select: { name: true } }, vendor: true, masterOrder: true, items: { include: { product: { include: { vendor: true } } } } } } } } },
      orderBy: { issuedAt: 'asc' },
    });
    const orderIds = [...new Set([...invoices.map((i) => i.orderId), ...notes.map((c) => c.orderId)])];
    const masterIds = [...new Set([...invoices, ...notes.map((c) => c.invoice)].map((i: any) => i.order?.masterOrderId).filter(Boolean))] as string[];
    const test = await this.testOrderIds(orderIds, masterIds);

    const pages = (inv: any) => {
      const o = inv.order;
      const snap = inv.lineItemsSnapshot || {};
      const parties = snap.parties || {};
      const seller = o.items?.find((it: any) => it.product?.vendor)?.product?.vendor;
      const customerName = o.masterOrder?.customerGstName || o.customer?.name || o.guestName || 'Customer';
      const customerGstin = o.masterOrder?.customerGstin || '';
      const partnerName = o.vendor?.businessName || o.vendor?.fullName || 'Partner';
      const lines = (arr: any[]) => (arr || []).map((l: any) => ({ hsnSac: l.hsnSac || '', description: l.description, qty: n(l.qty), rate: n(l.taxRatePercent), taxable: n(l.taxableValue), cgst: n(l.cgst), sgst: n(l.sgst), igst: n(l.igst) }));
      const out: Omit<DocRow, 'isCreditNote' | 'testOrder'>[] = [];
      const t = inv.transactionType || 'UNCLASSIFIED';
      // customer page
      const isSummary = t === 'PLATFORM_SERVICE' && !inv.section95;
      const custSupplierRemont = t === 'DIRECT_PROJECT' || (t === 'PLATFORM_SERVICE' && inv.section95) || (t === 'MARKETPLACE_PRODUCT' && !seller);
      const custGst = r2(n(inv.customerCgst) + n(inv.customerSgst) + n(inv.customerIgst));
      const partnerGst = r2(n(inv.vendorCgst) + n(inv.vendorSgst));
      out.push({
        docNo: inv.invoiceNumber, date: inv.generatedAt, orderId: o.id, orderNumber: o.orderNumber, transactionType: t,
        docType: isSummary ? 'BOOKING SUMMARY (not a tax invoice)' : t === 'PLATFORM_SERVICE' ? 'TAX INVOICE — SECTION 9(5)' : t === 'MARKETPLACE_PRODUCT' ? (seller ? 'PRODUCT TAX INVOICE (seller)' : 'PRODUCT TAX INVOICE (own stock)') : 'TAX INVOICE',
        supplierName: parties.customer?.supplier?.name || (custSupplierRemont ? company.legalName : seller?.businessName || partnerName),
        supplierGstin: (isSummary ? '' : parties.customer?.supplier?.gstin) || inv.supplierGstin || (custSupplierRemont ? company.gstin : seller?.gstNumber || ''),
        remontIsSupplier: custSupplierRemont, isTaxDocument: !isSummary,
        recipientName: parties.customer?.recipient?.name || customerName, recipientGstin: parties.customer?.recipient?.gstin || customerGstin,
        placeOfSupply: inv.placeOfSupply || '', interState: n(inv.customerIgst) > 0, section95: !!inv.section95,
        taxable: n(inv.customerSubtotal), cgst: n(inv.customerCgst), sgst: n(inv.customerSgst), igst: n(inv.customerIgst), total: n(inv.customerTotal),
        lines: lines(snap.customer),
        review: inv.taxReviewRequired ? 'GST collected; partner unregistered and category not under 9(5) — review'
          : isSummary && custGst - partnerGst > 0.01 ? `GST of Rs. ${r2(custGst - partnerGst)} collected with no tax invoice covering it — correct via reissue` : '',
      });
      if (inv.vendorDocumentNumber || n(inv.vendorTotal) > 0) {
        const reg = !!(o.vendor?.gstin && isValidGstinFormat(String(o.vendor.gstin).toUpperCase()));
        out.push({
          docNo: inv.vendorDocumentNumber || inv.invoiceNumber + '-PTR', date: inv.generatedAt, orderId: o.id, orderNumber: o.orderNumber, transactionType: t,
          docType: reg ? 'PARTNER TAX INVOICE (partner is supplier)' : 'PARTNER RECEIPT (no GST)',
          supplierName: parties.vendor?.supplier?.name || partnerName, supplierGstin: reg ? String(o.vendor.gstin) : '', remontIsSupplier: false, isTaxDocument: reg,
          recipientName: parties.vendor?.recipient?.name || customerName, recipientGstin: parties.vendor?.recipient?.gstin || customerGstin,
          placeOfSupply: inv.placeOfSupply || '', interState: false, section95: !!inv.section95,
          taxable: n(inv.vendorLabor), cgst: n(inv.vendorCgst), sgst: n(inv.vendorSgst), igst: 0, total: n(inv.vendorTotal), lines: lines(snap.vendor), review: '',
        });
      }
      if (inv.remontDocumentNumber || n(inv.remontTotal) > 0) {
        const rec = parties.remont?.recipient;
        const feeToCustomer = snap?.partnerDocument?.feeRecipient === 'CUSTOMER';
        // the frozen recipient is authoritative (a customer with no GSTIN must not inherit the partner's)
        const recipientGstin = (rec ? rec.gstin : (t === 'MARKETPLACE_PRODUCT' ? seller?.gstNumber : t === 'PLATFORM_SERVICE' && !feeToCustomer ? o.vendor?.gstin : customerGstin)) || '';
        out.push({
          docNo: inv.remontDocumentNumber || inv.invoiceNumber + '-FEE', date: inv.generatedAt, orderId: o.id, orderNumber: o.orderNumber, transactionType: t,
          docType: t === 'MARKETPLACE_PRODUCT' ? 'REMONT COMMISSION INVOICE (to seller)' : t === 'PLATFORM_SERVICE' ? (feeToCustomer ? 'REMONT PLATFORM FEE INVOICE (to customer)' : 'REMONT COMMISSION INVOICE (to partner)') : 'REMONT FEE INVOICE',
          supplierName: company.legalName, supplierGstin: company.gstin, remontIsSupplier: true, isTaxDocument: true,
          recipientName: rec?.name || (t === 'MARKETPLACE_PRODUCT' ? seller?.businessName : t === 'PLATFORM_SERVICE' && !feeToCustomer ? partnerName : customerName) || '',
          recipientGstin, placeOfSupply: rec?.state || (recipientGstin ? stateFromGstin(recipientGstin) : '') || inv.placeOfSupply || '',
          interState: n(inv.remontIgst) > 0, section95: false,
          taxable: r2(n(inv.platformCommission) + n(inv.bookingFee)), cgst: n(inv.remontCgst), sgst: n(inv.remontSgst), igst: n(inv.remontIgst), total: n(inv.remontTotal),
          lines: lines(snap.remont), review: '',
        });
      }
      return out;
    };

    const rows: DocRow[] = [];
    for (const inv of invoices) for (const pg of pages(inv)) rows.push({ ...pg, isCreditNote: false, testOrder: test.has(inv.orderId) });
    for (const c of notes) {
      // the credited document (a partner-marketplace refund credits each supplier's own document)
      const docs = pages(c.invoice);
      const docNoFor: Record<string, any> = { VENDOR: c.invoice.vendorDocumentNumber, REMONT: c.invoice.remontDocumentNumber || c.invoice.invoiceNumber + '-FEE' };
      const cust = (c.documentKind && c.documentKind !== 'CUSTOMER' && docs.find((d) => d.docNo === docNoFor[c.documentKind])) || docs[0];
      rows.push({
        ...cust, docNo: c.creditNoteNumber, date: c.issuedAt,
        docType: c.kind === 'INVOICE_CANCELLATION' ? 'CREDIT NOTE — invoice cancellation' : cust.isTaxDocument ? 'CREDIT NOTE — refund' : 'REFUND NOTE (against booking summary)',
        taxable: -n(c.taxableValueReversed), cgst: -n(c.cgstReversed), sgst: -n(c.sgstReversed), igst: -n(c.igstReversed), total: -n(c.totalReversed),
        interState: n(c.igstReversed) > 0, lines: [], isCreditNote: true, againstDoc: c.originalInvoiceNumber || c.invoice.invoiceNumber,
        testOrder: test.has(c.orderId), review: '',
      });
    }
    return rows;
  }

  /** Remont's own outward tax documents — what belongs in Remont's GST returns. */
  private remontRows(rows: DocRow[]) { return rows.filter((r) => r.remontIsSupplier && r.isTaxDocument && !r.testOrder); }

  async purchaseRows(range: DateRange) {
    const manual = await this.prisma.purchaseRecord.findMany({ where: { invoiceDate: within(range) }, orderBy: { invoiceDate: 'asc' } });
    const fees = await this.prisma.paymentTransaction.findMany({
      where: { status: 'PAID', gatewayFee: { not: null }, gateway: { notIn: TEST_GATEWAYS }, createdAt: within(range) },
      select: { id: true, gateway: true, gatewayPaymentId: true, createdAt: true, gatewayFee: true, gatewayFeeTax: true, orderId: true, masterOrderId: true },
      orderBy: { createdAt: 'asc' },
    });
    return [
      ...manual.map((p) => ({
        source: 'Purchase bill', date: p.invoiceDate, supplierName: p.supplierName, supplierGstin: p.supplierGstin || '', invoiceNumber: p.invoiceNumber,
        category: p.category, description: p.description || '', hsnSac: p.hsnSac || '',
        taxable: n(p.taxableValue), cgst: n(p.cgst), sgst: n(p.sgst), igst: n(p.igst), total: n(p.totalValue), itcEligible: p.itcEligible,
      })),
      // Razorpay invoices its fees monthly from Karnataka — GST on them is treated as IGST.
      ...fees.map((f) => ({
        source: 'Gateway fee', date: f.createdAt, supplierName: f.gateway === 'RAZORPAY' ? 'Razorpay (payment gateway)' : f.gateway, supplierGstin: '',
        invoiceNumber: f.gatewayPaymentId || f.id, category: 'GATEWAY_FEE', description: `Charges on payment ${f.gatewayPaymentId || f.id}`, hsnSac: '997158',
        taxable: n(f.gatewayFee), cgst: 0, sgst: 0, igst: n(f.gatewayFeeTax), total: r2(n(f.gatewayFee) + n(f.gatewayFeeTax)), itcEligible: true,
      })),
    ];
  }

  // ─── registers ─────────────────────────────────────────────────────────────

  async salesRegister(range: DateRange) {
    const rows = await this.documentRows(range);
    const wb = new Excel.Workbook();
    const cols: [string, string, number?][] = [
      ['Document No.', 'docNo', 24], ['Date', 'date', 12], ['Document Type', 'docType', 34], ['Against', 'againstDoc', 22], ['Order', 'orderNumber', 24],
      ['Supplier', 'supplierName', 26], ['Supplier GSTIN', 'supplierGstin', 18], ["In Remont's GST returns", 'inReturns', 12],
      ['Recipient', 'recipientName', 22], ['Recipient GSTIN', 'recipientGstin', 18], ['Place of Supply', 'placeOfSupply', 16], ['Section 9(5)', 's95', 10],
      ['Taxable Value', 'taxable'], ['CGST', 'cgst', 11], ['SGST', 'sgst', 11], ['IGST', 'igst', 11], ['Total', 'total'], ['Review', 'review', 40],
    ];
    const map = (r: DocRow) => ({ ...r, date: d(r.date), inReturns: r.remontIsSupplier && r.isTaxDocument ? 'Yes' : 'No', s95: r.section95 ? 'Yes' : '' });
    addSheet(wb, 'Sales Register', cols, rows.filter((r) => !r.testOrder).map(map), 'Every document issued in the period. Credit notes are negative. Partner/seller documents are listed for completeness — they belong in that supplier\'s own returns.');
    addSheet(wb, 'Test orders (excluded)', cols, rows.filter((r) => r.testOrder).map(map), 'Documents for orders paid only through test gateways (DEV_MOCK / RAZORPAY_DEV) — no real money; excluded from all totals.');
    return toBuffer(wb);
  }

  async purchaseRegister(range: DateRange) {
    const rows = await this.purchaseRows(range);
    const wb = new Excel.Workbook();
    addSheet(wb, 'Purchase Register', [
      ['Source', 'source', 14], ['Date', 'date', 12], ['Supplier', 'supplierName', 26], ['Supplier GSTIN', 'supplierGstin', 18], ['Bill / Ref No.', 'invoiceNumber', 24],
      ['Category', 'category', 14], ['Description', 'description', 30], ['HSN/SAC', 'hsnSac', 10], ['Taxable Value', 'taxable'], ['CGST', 'cgst', 11], ['SGST', 'sgst', 11], ['IGST', 'igst', 11], ['Total', 'total'], ['ITC eligible', 'itc', 10],
    ], rows.map((r) => ({ ...r, date: d(r.date), itc: r.itcEligible ? 'Yes' : 'No' })),
    'Purchase bills are entered by admins (Admin › Reports › Purchases). Gateway fees come from Razorpay payment data; claim ITC only against the gateway\'s GST invoice.');
    return toBuffer(wb);
  }

  // ─── GST summaries ─────────────────────────────────────────────────────────

  private async b2clThreshold() {
    const s = await this.prisma.siteSetting.findUnique({ where: { key: 'gstr1_b2cl_threshold' } });
    const v = Number(s?.value);
    return { value: v > 0 ? v : 100000, configured: v > 0 };
  }

  async gstSummaryData(range: DateRange) {
    const all = await this.documentRows(range);
    const remont = this.remontRows(all);
    const purchases = await this.purchaseRows(range);
    const sum = (rows: { taxable: number; cgst: number; sgst: number; igst: number }[]) => rows.reduce((a, r) => ({
      taxable: r2(a.taxable + r.taxable), cgst: r2(a.cgst + r.cgst), sgst: r2(a.sgst + r.sgst), igst: r2(a.igst + r.igst),
    }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    const ownSupplies = sum(remont.filter((r) => !r.section95));
    const eco95 = sum(remont.filter((r) => r.section95));
    const itc = sum(purchases.filter((p) => p.itcEligible));
    const output = { cgst: r2(ownSupplies.cgst + eco95.cgst), sgst: r2(ownSupplies.sgst + eco95.sgst), igst: r2(ownSupplies.igst + eco95.igst) };
    const review = all.filter((r) => r.review && !r.testOrder && !r.isCreditNote);
    return {
      period: { from: range.from || null, to: range.to || null },
      gstr3b: {
        '3.1(a) outward taxable supplies (net of credit notes)': ownSupplies,
        '3.1.1(i) supplies on which Remont as ECO pays tax u/s 9(5) (net of credit notes)': eco95,
        '4(A)(5) all other ITC (purchase bills + gateway fees)': itc,
        outputTax: output,
        netPayableBeforeSetOff: { cgst: r2(output.cgst - itc.cgst), sgst: r2(output.sgst - itc.sgst), igst: r2(output.igst - itc.igst), total: r2(output.cgst + output.sgst + output.igst - itc.cgst - itc.sgst - itc.igst) },
      },
      documentsNeedingReview: review.length,
      gstCollectedWithoutTaxInvoice: r2(review.reduce((a, r) => a + r.cgst + r.sgst + r.igst, 0)),
      testOrdersExcluded: new Set(all.filter((r) => r.testOrder).map((r) => r.orderId)).size,
      note: NOT_FILED,
    };
  }

  async gstr1(range: DateRange) {
    const rows = this.remontRows(await this.documentRows(range));
    const threshold = await this.b2clThreshold();
    const invoices = rows.filter((r) => !r.isCreditNote);
    const regular = invoices.filter((r) => !r.section95);
    const isB2B = (r: DocRow) => !!r.recipientGstin && isValidGstinFormat(String(r.recipientGstin).toUpperCase());
    const b2b = regular.filter(isB2B);
    const b2cl = regular.filter((r) => !isB2B(r) && r.interState && r.total > threshold.value);
    const b2cs = regular.filter((r) => !isB2B(r) && !(r.interState && r.total > threshold.value));
    const b2csAgg = new Map<string, any>();
    for (const r of b2cs) for (const l of (r.lines.length ? r.lines : [{ rate: 0, taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst } as any])) {
      const key = `${r.placeOfSupply}|${l.rate}|${r.interState ? 'Inter' : 'Intra'}`;
      const a = b2csAgg.get(key) || { placeOfSupply: r.placeOfSupply, rate: l.rate, supplyType: r.interState ? 'Inter-state' : 'Intra-state', taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      a.taxable = r2(a.taxable + l.taxable); a.cgst = r2(a.cgst + l.cgst); a.sgst = r2(a.sgst + l.sgst); a.igst = r2(a.igst + l.igst);
      b2csAgg.set(key, a);
    }
    const hsn = new Map<string, any>();
    for (const r of invoices) for (const l of r.lines) {
      const key = `${l.hsnSac}|${l.rate}`;
      const a = hsn.get(key) || { hsnSac: l.hsnSac || '(none)', rate: l.rate, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      a.qty += l.qty; a.taxable = r2(a.taxable + l.taxable); a.cgst = r2(a.cgst + l.cgst); a.sgst = r2(a.sgst + l.sgst); a.igst = r2(a.igst + l.igst);
      hsn.set(key, a);
    }
    const invCols: [string, string, number?][] = [['Invoice No.', 'docNo', 24], ['Date', 'date', 12], ['Recipient', 'recipientName', 24], ['Recipient GSTIN', 'recipientGstin', 18], ['Place of Supply', 'placeOfSupply', 16], ['Invoice Value', 'total'], ['Taxable Value', 'taxable'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst'], ['Document', 'docType', 32]];
    const fmt = (r: DocRow) => ({ ...r, date: d(r.date) });
    const wb = new Excel.Workbook();
    addSheet(wb, 'Read me', [['Item', 'k', 40], ['Value', 'v', 80]], [
      { k: 'Status', v: NOT_FILED },
      { k: 'Supplier', v: 'Only documents where Remont India is the supplier. Partner/seller documents belong in their own returns.' },
      { k: 'B2CL threshold (inter-state, unregistered)', v: `Rs. ${threshold.value}${threshold.configured ? ' (from setting gstr1_b2cl_threshold)' : ' (default — set gstr1_b2cl_threshold in Admin › Settings to change)'}` },
      { k: 'Section 9(5)', v: 'Supplies where Remont as e-commerce operator pays the tax are on their own sheet (GSTR-1 Table 15), not in B2B/B2CS.' },
      { k: 'Test orders', v: 'Orders paid only through test gateways are excluded.' },
    ]);
    addSheet(wb, 'B2B', invCols, b2b.map(fmt));
    addSheet(wb, 'B2CL', invCols, b2cl.map(fmt));
    addSheet(wb, 'B2CS', [['Place of Supply', 'placeOfSupply', 18], ['Supply', 'supplyType', 12], ['Rate %', 'rate', 8], ['Taxable Value', 'taxable'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst']], [...b2csAgg.values()]);
    addSheet(wb, '9(5) ECO supplies', invCols, invoices.filter((r) => r.section95).map(fmt), 'Services supplied through Remont by unregistered partners — tax paid by Remont as ECO u/s 9(5).');
    addSheet(wb, 'Credit Notes', [['Credit Note No.', 'docNo', 24], ['Date', 'date', 12], ['Against Invoice', 'againstDoc', 24], ['Recipient GSTIN', 'recipientGstin', 18], ['Registered recipient', 'reg', 10], ['Section 9(5)', 's95', 10], ['Note Value', 'total'], ['Taxable Value', 'taxable'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst'], ['Type', 'docType', 30]],
      rows.filter((r) => r.isCreditNote).map((r) => ({ ...fmt(r), reg: isB2B(r) ? 'Yes (CDNR)' : 'No', s95: r.section95 ? 'Yes' : '' })),
      'Values are negative. Unregistered B2CS credit notes adjust B2CS; only inter-state B2CL-size notes go to CDNUR.');
    addSheet(wb, 'HSN Summary', [['HSN/SAC', 'hsnSac', 12], ['Rate %', 'rate', 8], ['Quantity', 'qty', 10], ['Taxable Value', 'taxable'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['IGST', 'igst']], [...hsn.values()], 'Before credit notes.');
    return toBuffer(wb);
  }

  async gstr3b(range: DateRange) {
    const s = await this.gstSummaryData(range);
    const wb = new Excel.Workbook();
    const rows = Object.entries(s.gstr3b).filter(([k]) => k !== 'netPayableBeforeSetOff' && k !== 'outputTax').map(([k, v]: any) => ({ table: k, ...v }));
    rows.push({ table: 'Output tax (3.1(a) + 3.1.1(i))', ...(s.gstr3b.outputTax as any) });
    rows.push({ table: 'Net payable before set-off (output − ITC, per head)', ...(s.gstr3b.netPayableBeforeSetOff as any) });
    addSheet(wb, 'GSTR-3B aid', [['Table', 'table', 70], ['Taxable Value', 'taxable'], ['IGST', 'igst'], ['CGST', 'cgst'], ['SGST', 'sgst'], ['Total', 'total']], rows,
      `${NOT_FILED} Cross-utilisation of ITC (IGST against CGST/SGST) is not applied here. Documents needing review: ${s.documentsNeedingReview}; GST collected without a tax invoice: Rs. ${s.gstCollectedWithoutTaxInvoice}.`);
    return toBuffer(wb);
  }

  /** Month-wise GST position: output tax, credit notes, ITC, net. */
  async gstPayable(range: DateRange) {
    const docs = this.remontRows(await this.documentRows(range));
    const purchases = (await this.purchaseRows(range)).filter((p) => p.itcEligible);
    const m = new Map<string, any>();
    const get = (k: string) => m.get(k) || m.set(k, { month: k, outputTax: 0, eco95Tax: 0, creditNoteTax: 0, itc: 0 }).get(k);
    for (const r of docs) {
      const tax = r.cgst + r.sgst + r.igst; const a = get(month(r.date));
      if (r.isCreditNote) a.creditNoteTax = r2(a.creditNoteTax + tax);
      else if (r.section95) a.eco95Tax = r2(a.eco95Tax + tax);
      else a.outputTax = r2(a.outputTax + tax);
    }
    for (const p of purchases) { const a = get(month(p.date)); a.itc = r2(a.itc + p.cgst + p.sgst + p.igst); }
    const rows = [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((a) => ({ ...a, net: r2(a.outputTax + a.eco95Tax + a.creditNoteTax - a.itc) }));
    const wb = new Excel.Workbook();
    addSheet(wb, 'GST Payable', [['Month', 'month', 10], ['Output tax (own supplies)', 'outputTax', 22], ['Tax as ECO u/s 9(5)', 'eco95Tax', 20], ['Credit notes (tax reversed)', 'creditNoteTax', 22], ['ITC available', 'itc', 16], ['Net payable', 'net', 16]], rows,
      `${NOT_FILED} Credit-note tax is negative. ITC = purchase bills marked eligible + GST on gateway fees.`);
    return toBuffer(wb);
  }

  // ─── revenue, refunds, settlements, gateway fees, profitability ───────────

  /** Remont's own revenue per order (taxable value, excluding GST), from the issued documents. */
  private remontRevenue(inv: any, hasSeller: boolean) {
    const t = inv.transactionType;
    if (t === 'DIRECT_PROJECT') return n(inv.customerSubtotal);
    if (t === 'MARKETPLACE_PRODUCT' && !hasSeller) return n(inv.customerSubtotal);
    return r2(n(inv.platformCommission) + n(inv.bookingFee));
  }

  private async orderFacts(range: DateRange) {
    const invoices = await this.prisma.invoice.findMany({
      where: { generatedAt: within(range) },
      include: { creditNotes: true, order: { include: { vendor: { select: { id: true, fullName: true, businessName: true, staffType: true } }, items: { select: { vendorId: true, product: { select: { vendor: { select: { id: true, businessName: true } } } } } } } } },
      orderBy: { generatedAt: 'asc' },
    });
    const orderIds = invoices.map((i) => i.orderId);
    const masterIds = [...new Set(invoices.map((i) => i.order.masterOrderId).filter(Boolean))] as string[];
    const test = await this.testOrderIds(orderIds, masterIds);
    const pays = orderIds.length ? await this.prisma.paymentTransaction.findMany({
      where: { status: 'PAID', isWalletTopup: false, refundRequestId: null, gateway: { notIn: TEST_GATEWAYS }, OR: [{ orderId: { in: orderIds } }, ...(masterIds.length ? [{ masterOrderId: { in: masterIds } }, { orderId: { in: masterIds } }] : [])] },
      select: { orderId: true, masterOrderId: true, amount: true, gatewayFee: true },
    }) : [];
    const siblings = masterIds.length ? await this.prisma.order.findMany({ where: { masterOrderId: { in: masterIds } }, select: { id: true, masterOrderId: true, totalAmount: true } }) : [];
    const masterTotal = new Map<string, number>();
    for (const s of siblings) masterTotal.set(s.masterOrderId!, n(masterTotal.get(s.masterOrderId!)) + n(s.totalAmount));
    const refunds = orderIds.length ? await this.prisma.refundRequest.findMany({ where: { orderId: { in: orderIds }, status: 'PROCESSED' } }) : [];
    const shipments = orderIds.length ? await this.prisma.shipment.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, actualDeliveryCost: true } }) : [];
    const shipCost = new Map(shipments.map((s) => [s.orderId, n(s.actualDeliveryCost)]));

    return invoices.map((inv) => {
      const o: any = inv.order;
      const seller = o.items.find((it: any) => it.product?.vendor)?.product?.vendor || null;
      let gatewayFee = 0; let feeMissing = false;
      for (const p of pays) {
        let share = 0;
        if (p.orderId === o.id) share = 1;
        else if (o.masterOrderId && (p.masterOrderId === o.masterOrderId || p.orderId === o.masterOrderId)) share = n(o.totalAmount) / (masterTotal.get(o.masterOrderId) || 1);
        if (!share) continue;
        if (p.gatewayFee == null) feeMissing = true; else gatewayFee += n(p.gatewayFee) * share;
      }
      const rr = refunds.filter((r) => r.orderId === o.id);
      const refunded = r2(rr.reduce((a, r) => a + (r.walletCreditAmount != null || r.gatewayRefundAmount != null ? n(r.walletCreditAmount) + n(r.gatewayRefundAmount) : n(r.approvedAmount)), 0));
      const recovered = r2(rr.reduce((a, r) => a + n(r.partnerRecovery), 0));
      const revenue = this.remontRevenue(inv, !!seller);
      // Refund cost to Remont: Remont-supplied documents lose the credited taxable value;
      // on a partner job the refund not recovered from the partner is Remont's cost.
      const cnTaxable = r2(inv.creditNotes.filter((c) => c.kind !== 'INVOICE_CANCELLATION').reduce((a, c) => a + n(c.taxableValueReversed), 0));
      const refundCost = inv.transactionType === 'PLATFORM_SERVICE' || (inv.transactionType === 'MARKETPLACE_PRODUCT' && seller)
        ? Math.max(0, r2(refunded - recovered)) : cnTaxable;
      return {
        orderId: o.id, orderNumber: o.orderNumber, date: inv.generatedAt, type: inv.transactionType || 'UNCLASSIFIED', test: test.has(o.id),
        partner: o.vendor ? (o.vendor.businessName || o.vendor.fullName) : '', partnerId: o.vendor?.id || '', inHouse: o.vendor?.staffType === 'IN_HOUSE',
        seller: seller?.businessName || '', sellerId: seller?.id || '',
        billed: n(inv.customerTotal), gstCollected: r2(n(inv.customerCgst) + n(inv.customerSgst) + n(inv.customerIgst)),
        commission: n(inv.platformCommission), partnerShare: n(o.vendorPayout), revenue,
        refunded, recovered, refundCost, gatewayFee: r2(gatewayFee), feeMissing, deliveryCost: shipCost.get(o.id) || 0,
        contribution: r2(revenue - refundCost - gatewayFee - (shipCost.get(o.id) || 0)),
      };
    });
  }

  async revenueReport(range: DateRange) {
    const facts = (await this.orderFacts(range)).filter((f) => !f.test);
    const byMonth = new Map<string, any>();
    for (const f of facts) {
      const k = month(f.date);
      const a = byMonth.get(k) || { month: k, billed: 0, gst: 0, commission: 0, directIncome: 0, ownStockIncome: 0, platformIncome: 0, revenue: 0 };
      a.billed = r2(a.billed + f.billed); a.gst = r2(a.gst + f.gstCollected); a.revenue = r2(a.revenue + f.revenue);
      if (f.type === 'DIRECT_PROJECT') a.directIncome = r2(a.directIncome + f.revenue);
      else if (f.type === 'MARKETPLACE_PRODUCT' && !f.seller) a.ownStockIncome = r2(a.ownStockIncome + f.revenue);
      else { a.platformIncome = r2(a.platformIncome + f.revenue); a.commission = r2(a.commission + f.commission); }
      byMonth.set(k, a);
    }
    const wb = new Excel.Workbook();
    addSheet(wb, 'Revenue by month', [['Month', 'month', 10], ['Billed to customers (incl. GST)', 'billed', 24], ['GST collected', 'gst'], ['Commission / platform income', 'platformIncome', 24], ['Direct (in-house) service income', 'directIncome', 26], ['Own-stock product income', 'ownStockIncome', 22], ["Remont's revenue (excl. GST)", 'revenue', 22]], [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
      "Revenue = Remont's own taxable income: commission/fees on partner jobs and seller sales; the full value of in-house jobs and own-stock products. Partner/seller shares are not Remont revenue.");
    addSheet(wb, 'By order', [['Order', 'orderNumber', 24], ['Date', 'date', 12], ['Type', 'type', 20], ['Partner', 'partner', 20], ['Seller', 'seller', 20], ['Billed', 'billed'], ['GST collected', 'gstCollected'], ['Commission', 'commission'], ['Partner share', 'partnerShare'], ["Remont's revenue", 'revenue']], facts.map((f) => ({ ...f, date: d(f.date) })));
    return toBuffer(wb);
  }

  async profitability(range: DateRange) {
    const facts = (await this.orderFacts(range)).filter((f) => !f.test);
    const group = (key: (f: any) => string) => {
      const m = new Map<string, any>();
      for (const f of facts) {
        const k = key(f); if (!k) continue;
        const a = m.get(k) || { group: k, orders: 0, revenue: 0, refundCost: 0, gatewayFee: 0, deliveryCost: 0, contribution: 0, feeMissing: 0 };
        a.orders++; a.revenue = r2(a.revenue + f.revenue); a.refundCost = r2(a.refundCost + f.refundCost); a.gatewayFee = r2(a.gatewayFee + f.gatewayFee);
        a.deliveryCost = r2(a.deliveryCost + f.deliveryCost); a.contribution = r2(a.contribution + f.contribution); if (f.feeMissing) a.feeMissing++;
        m.set(k, a);
      }
      return [...m.values()].map((a) => ({ ...a, margin: a.revenue ? `${r2((a.contribution / a.revenue) * 100)}%` : '' }));
    };
    const cols: [string, string, number?][] = [['Group', 'group', 30], ['Orders', 'orders', 8], ["Remont's revenue", 'revenue'], ['Refund cost', 'refundCost'], ['Gateway fees', 'gatewayFee'], ['Delivery cost', 'deliveryCost'], ['Contribution', 'contribution'], ['Margin', 'margin', 10], ['Orders with gateway fee unknown', 'feeMissing', 14]];
    const caveat = 'Contribution before overheads. NOT included (not recorded in the system): cost of goods for own-stock products, in-house technician salaries, marketing and other overheads. Gateway fees are only those recorded — run the gateway-fee backfill for older payments.';
    const wb = new Excel.Workbook();
    addSheet(wb, 'Overall', cols, group(() => 'All orders'), caveat);
    addSheet(wb, 'By line of business', cols, group((f) => f.type === 'MARKETPLACE_PRODUCT' ? (f.seller ? 'Products — marketplace sellers' : 'Products — own stock') : f.type === 'DIRECT_PROJECT' ? 'Services — in-house' : 'Services — partners'));
    addSheet(wb, 'By partner', cols, group((f) => (f.type === 'PLATFORM_SERVICE' && f.partner) || ''));
    addSheet(wb, 'By seller', cols, group((f) => f.seller || ''));
    addSheet(wb, 'By order', [['Order', 'orderNumber', 24], ['Date', 'date', 12], ['Type', 'type', 20], ['Partner', 'partner', 18], ['Seller', 'seller', 18], ["Remont's revenue", 'revenue'], ['Refunded', 'refunded'], ['Recovered from partner', 'recovered'], ['Refund cost', 'refundCost'], ['Gateway fee', 'gatewayFee'], ['Delivery cost', 'deliveryCost'], ['Contribution', 'contribution']], facts.map((f) => ({ ...f, date: d(f.date) })));
    return toBuffer(wb);
  }

  async refundsReport(range: DateRange) {
    const rr = await this.prisma.refundRequest.findMany({
      where: { createdAt: within(range) },
      include: { providerRefund: true },
      orderBy: { createdAt: 'asc' },
    });
    const orderIds = rr.map((r) => r.orderId).filter(Boolean) as string[];
    const orders = orderIds.length ? await this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } }) : [];
    const num = new Map(orders.map((o) => [o.id, o.orderNumber]));
    const cns = rr.length ? await this.prisma.creditNote.findMany({ where: { refundRequestId: { in: rr.map((r) => r.id) } }, select: { refundRequestId: true, creditNoteNumber: true } }) : [];
    const cnBy = new Map<string, string[]>();
    for (const c of cns) cnBy.set(c.refundRequestId!, [...(cnBy.get(c.refundRequestId!) || []), c.creditNoteNumber]);
    const wb = new Excel.Workbook();
    addSheet(wb, 'Refunds', [
      ['Refund request', 'id', 26], ['Raised', 'createdAt', 12], ['Order', 'order', 24], ['Status', 'status', 14], ['Approved', 'approvedAmount'], ['Wallet credit', 'walletCreditAmount'],
      ['Gateway refund', 'gatewayRefundAmount'], ['Gateway status', 'providerStatus', 14], ['Gateway refund id', 'gatewayRefundId', 22], ['Recovered from partner', 'partnerRecovery'], ['Credit notes', 'creditNotes', 30], ['Decided', 'approvedAt', 12], ['Reason', 'reason', 30],
    ], rr.map((r) => ({
      id: r.id, createdAt: d(r.createdAt), order: (r.orderId && num.get(r.orderId)) || r.masterOrderId || '', status: r.status,
      approvedAmount: n(r.approvedAmount), walletCreditAmount: n(r.walletCreditAmount), gatewayRefundAmount: n(r.gatewayRefundAmount),
      providerStatus: r.providerRefund?.status || '', gatewayRefundId: r.gatewayRefundId || r.providerRefund?.providerRefundId || '',
      partnerRecovery: n(r.partnerRecovery), creditNotes: (cnBy.get(r.id) || []).join(', '), approvedAt: d(r.approvedAt), reason: r.reason,
    })), 'A refund is money only once PROCESSED (wallet credited / gateway refund processed). Credit notes are issued only where an invoice exists.');
    const notes = await this.prisma.creditNote.findMany({ where: { issuedAt: within(range) }, include: { invoice: { select: { invoiceNumber: true } } }, orderBy: { issuedAt: 'asc' } });
    addSheet(wb, 'Credit notes', [['Credit Note No.', 'creditNoteNumber', 24], ['Kind', 'kind', 20], ['Against', 'against', 24], ['Issued', 'issuedAt', 12], ['Taxable reversed', 'taxable'], ['GST reversed', 'gst'], ['Total reversed', 'total'], ['Reason', 'reason', 40]],
      notes.map((c) => ({ creditNoteNumber: c.creditNoteNumber, kind: c.kind, against: c.originalInvoiceNumber || c.invoice.invoiceNumber, issuedAt: d(c.issuedAt), taxable: n(c.taxableValueReversed), gst: r2(n(c.cgstReversed) + n(c.sgstReversed) + n(c.igstReversed)), total: n(c.totalReversed), reason: c.reason })));
    return toBuffer(wb);
  }

  async settlementsReport(range: DateRange) {
    const partner = await this.prisma.partnerSettlement.findMany({ where: { paidAt: within(range) }, include: { vendor: { select: { fullName: true, businessName: true } } }, orderBy: { paidAt: 'asc' } });
    const seller = await this.prisma.productVendorSettlement.findMany({ where: { paidAt: within(range) }, include: { vendor: { select: { businessName: true } } }, orderBy: { paidAt: 'asc' } });
    const cols: [string, string, number?][] = [['Paid on', 'paidAt', 12], ['Payee', 'payee', 28], ['Amount', 'amount'], ['Mode', 'mode', 12], ['Reference', 'referenceNumber', 24], ['Notes', 'notes', 30], ['Paid by', 'paidBy', 26]];
    const wb = new Excel.Workbook();
    addSheet(wb, 'Partner payouts', cols, partner.map((s) => ({ ...s, paidAt: d(s.paidAt), payee: s.vendor.businessName || s.vendor.fullName, amount: n(s.amount) })));
    addSheet(wb, 'Seller payouts', cols, seller.map((s) => ({ ...s, paidAt: d(s.paidAt), payee: s.vendor.businessName, amount: n(s.amount) })));
    return toBuffer(wb);
  }

  async gatewayFeesReport(range: DateRange) {
    const pays = await this.prisma.paymentTransaction.findMany({
      where: { status: 'PAID', isWalletTopup: false, refundRequestId: null, gateway: { notIn: [...TEST_GATEWAYS, 'WALLET'] }, collectionMode: null, createdAt: within(range) },
      orderBy: { createdAt: 'asc' },
    });
    const rows = pays.map((p) => ({
      date: d(p.createdAt), gateway: p.gateway, paymentId: p.gatewayPaymentId || '', ref: p.orderId || p.masterOrderId || p.amcSubscriptionId || '', amount: n(p.amount),
      fee: p.gatewayFee == null ? 'not recorded' : n(p.gatewayFee), feeGst: p.gatewayFeeTax == null ? '' : n(p.gatewayFeeTax),
      net: p.gatewayFee == null ? '' : r2(n(p.amount) - n(p.gatewayFee) - n(p.gatewayFeeTax)),
    }));
    const missing = pays.filter((p) => p.gatewayFee == null).length;
    const wb = new Excel.Workbook();
    addSheet(wb, 'Gateway fees', [['Date', 'date', 12], ['Gateway', 'gateway', 12], ['Payment id', 'paymentId', 24], ['Order / reference', 'ref', 26], ['Amount', 'amount'], ['Fee (excl. GST)', 'fee'], ['GST on fee', 'feeGst'], ['Net settled', 'net']], rows,
      `${missing} of ${pays.length} payments have no fee recorded — use "Backfill gateway fees" (Admin › Reports) to fetch them from Razorpay.`);
    return toBuffer(wb);
  }

  /** DEV_MOCK / RAZORPAY_DEV payments — segregated, never counted as money received. */
  async testPayments() {
    const pays = await this.prisma.paymentTransaction.findMany({ where: { gateway: { in: TEST_GATEWAYS } }, orderBy: { createdAt: 'asc' } });
    const wb = new Excel.Workbook();
    addSheet(wb, 'Test-gateway payments', [['Date', 'date', 12], ['Gateway', 'gateway', 14], ['Status', 'status', 10], ['Amount', 'amount'], ['Order', 'orderId', 26], ['Master order', 'masterOrderId', 26], ['Wallet top-up', 'topup', 10], ['Payment id', 'gatewayPaymentId', 24]],
      pays.map((p) => ({ ...p, date: d(p.createdAt), amount: n(p.amount), topup: p.isWalletTopup ? 'Yes' : '' })),
      'Payments recorded through development/test gateways. No real money moved; they are excluded from every accounting report. Records are kept, not deleted.');
    return {
      buffer: await toBuffer(wb),
      summary: { count: pays.length, paidCount: pays.filter((p) => p.status === 'PAID').length, paidTotal: r2(pays.filter((p) => p.status === 'PAID').reduce((a, p) => a + n(p.amount), 0)) },
    };
  }

  // ─── partner payout reconciliation + authorised correction ────────────────

  async partnerPayoutReconciliation() {
    const vendors = await this.prisma.serviceVendor.findMany({ select: { id: true, fullName: true, businessName: true, staffType: true, pendingPayout: true } });
    const out: any[] = [];
    for (const v of vendors) {
      const last = await this.prisma.partnerLedgerEntry.findFirst({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, select: { balanceAfter: true, createdAt: true } });
      const first = await this.prisma.partnerLedgerEntry.findFirst({ where: { vendorId: v.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
      const pending = n(v.pendingPayout); const ledger = n(last?.balanceAfter);
      if (Math.abs(pending - ledger) < 0.01) continue;
      // Completed jobs that never got a JOB_EARNING ledger entry — the usual cause of a gap.
      const jobs = await this.prisma.order.findMany({
        where: { vendorId: v.id, status: { in: ['COMPLETED', 'INVOICED', 'CLOSED'] } },
        select: { id: true, orderNumber: true, vendorPayout: true, completedAt: true },
      });
      const posted = new Set((await this.prisma.partnerLedgerEntry.findMany({ where: { vendorId: v.id, type: 'JOB_EARNING' }, select: { orderId: true } })).map((e) => e.orderId));
      const unposted = v.staffType === 'IN_HOUSE' ? [] : jobs.filter((j) => !posted.has(j.id)).map((j) => ({ orderId: j.id, orderNumber: j.orderNumber, vendorPayout: n(j.vendorPayout), completedAt: j.completedAt }));
      const difference = r2(pending - ledger);
      const explained = r2(unposted.reduce((a, j) => a + j.vendorPayout, 0));
      out.push({
        vendorId: v.id, name: v.businessName || v.fullName, staffType: v.staffType, pendingPayout: pending, ledgerBalance: ledger, difference,
        ledgerStartedAt: first?.createdAt || null, unpostedJobs: unposted, explainedByUnpostedJobs: explained, unexplained: r2(difference - explained),
        suggestion: v.staffType === 'IN_HOUSE'
          ? 'In-house staff: no partner balance should exist — review and correct by authorised adjustment.'
          : Math.abs(difference - explained) < 0.01 && unposted.length
            ? 'Gap equals completed job(s) never posted to the ledger — post them as an authorised ledger adjustment.'
            : 'Gap not fully explained by unposted jobs — investigate before correcting.',
      });
    }
    return { mismatches: out.length, vendors: out, note: 'Read-only. Corrections are applied only by a SUPER_ADMIN through the correction action, with a reason, and are audited.' };
  }

  /**
   * SUPER_ADMIN: bring a partner's ledger in line with the balance actually owed by posting an
   * ADJUSTMENT entry (pendingPayout — the amount that drives withdrawals — is left unchanged).
   * The caller must state the difference they reviewed; a stale or different figure is refused.
   */
  async correctPartnerLedger(actor: { sub: string; role: UserRole }, vendorId: string, body: { amount: number; expectedDifference: number; reason: string; orderId?: string }) {
    const reason = String(body?.reason || '').trim();
    const amount = r2(Number(body?.amount));
    if (reason.length < 10) throw new BadRequestException('A reason of at least 10 characters is required');
    if (!amount || Number.isNaN(amount)) throw new BadRequestException('amount is required');
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.serviceVendor.findUnique({ where: { id: vendorId }, select: { pendingPayout: true } });
      if (!v) throw new NotFoundException('Partner not found');
      await tx.$queryRaw`SELECT id FROM "ServiceVendor" WHERE id = ${vendorId} FOR UPDATE`;
      const last = await tx.partnerLedgerEntry.findFirst({ where: { vendorId }, orderBy: { createdAt: 'desc' }, select: { balanceAfter: true } });
      const difference = r2(n(v.pendingPayout) - n(last?.balanceAfter));
      if (Math.abs(difference - r2(Number(body.expectedDifference))) >= 0.01) throw new ConflictException(`The difference is now Rs. ${difference} — review the reconciliation again`);
      if (Math.sign(amount) !== Math.sign(difference) || Math.abs(amount) - Math.abs(difference) > 0.009) throw new BadRequestException(`The adjustment must move the ledger toward the payout balance and not exceed the difference of Rs. ${difference}`);
      const entry = await this.ledger.postEntry(tx, vendorId, 'ADJUSTMENT', amount, { orderId: body.orderId, notes: `Reconciliation correction: ${reason}`, createdBy: actor.sub });
      await logAudit(tx, { actorId: actor.sub, actorRole: actor.role, action: 'PARTNER_LEDGER_RECONCILIATION_ADJUSTMENT', targetType: 'ServiceVendor', targetId: vendorId, metadata: { amount, differenceBefore: difference, orderId: body.orderId || null, reason, ledgerEntryId: entry.id } });
      return { ledgerEntryId: entry.id, amount, differenceBefore: difference, differenceAfter: r2(difference - amount) };
    });
  }

  /**
   * e-Invoice (IRP) and e-Way Bill: only MOCK adapters exist (compliance.module.ts) — no GSP/IRP
   * credentials, so nothing is ever registered with the government. Every record is SANDBOX.
   */
  async eInvoiceStatus() {
    const [einv, eway] = await Promise.all([
      this.prisma.eInvoiceRecord.groupBy({ by: ['environment', 'status'], _count: { _all: true } }),
      this.prisma.eWayBillRecord.groupBy({ by: ['environment', 'status'], _count: { _all: true } }),
    ]);
    return {
      mode: 'SIMULATION', liveIntegration: false,
      message: 'e-Invoice and e-Way Bill are simulated only. No IRN or e-Way Bill number in this system is government-issued; MOCK-* numbers have no legal validity. A GSP/IRP integration with credentials is required before go-live where e-invoicing applies.',
      eInvoiceRecords: einv.map((r: any) => ({ environment: r.environment, status: r.status, count: r._count._all })),
      eWayBillRecords: eway.map((r: any) => ({ environment: r.environment, status: r.status, count: r._count._all })),
    };
  }

  // ─── purchases (input-tax records) ────────────────────────────────────────

  async createPurchase(actorId: string, b: any) {
    const need = ['supplierName', 'invoiceNumber', 'invoiceDate'];
    for (const k of need) if (!b?.[k]) throw new BadRequestException(`${k} is required`);
    const taxable = r2(Number(b.taxableValue)); const cgst = r2(Number(b.cgst || 0)); const sgst = r2(Number(b.sgst || 0)); const igst = r2(Number(b.igst || 0));
    if (!(taxable > 0)) throw new BadRequestException('taxableValue must be positive');
    if ([cgst, sgst, igst].some((x) => x < 0 || Number.isNaN(x))) throw new BadRequestException('Tax amounts cannot be negative');
    if (igst > 0 && (cgst > 0 || sgst > 0)) throw new BadRequestException('A bill carries either IGST or CGST+SGST, not both');
    const gstin = b.supplierGstin ? String(b.supplierGstin).trim().toUpperCase() : null;
    if (gstin && !isValidGstinFormat(gstin)) throw new BadRequestException('Supplier GSTIN is not valid');
    // Salary of Remont's in-house technicians: an employee expense, recorded separately from service
    // accounting — never GST, never input tax credit, never netted against cash they collected.
    if (b.category === 'SALARY' && (cgst > 0 || sgst > 0 || igst > 0 || gstin)) throw new BadRequestException('Salary carries no GST and no supplier GSTIN');
    const date = new Date(b.invoiceDate);
    if (isNaN(date.getTime())) throw new BadRequestException('invoiceDate is not a valid date');
    const rec = await this.prisma.purchaseRecord.create({ data: {
      supplierName: String(b.supplierName).trim(), supplierGstin: gstin, supplierState: gstin ? stateFromGstin(gstin) : (b.supplierState || null),
      invoiceNumber: String(b.invoiceNumber).trim(), invoiceDate: date, category: b.category || 'GENERAL', description: b.description || null, hsnSac: b.hsnSac || null,
      taxableValue: taxable, cgst, sgst, igst, totalValue: r2(taxable + cgst + sgst + igst),
      // ITC needs the supplier's GSTIN on the bill.
      itcEligible: b.category === 'SALARY' || b.itcEligible === false ? false : !!gstin, createdBy: actorId,
    } });
    return rec;
  }

  // ─── In-house technicians: cash collected on Remont's behalf, and its deposit ───────────
  // Verified cash on an in-house job is already a COD_COLLECTION debit on that technician's ledger
  // (OrdersService.applyVerifiedCashTx) — the cash they hold for Remont. A verified deposit is a
  // CASH_DEPOSIT credit against the same order. Never salary, never partner earnings or commission.

  private async employeeCashByOrder(client: any, vendorId: string, orderIds?: string[]) {
    const rows = await client.partnerLedgerEntry.findMany({
      where: { vendorId, type: { in: ['COD_COLLECTION', 'CASH_DEPOSIT'] }, orderId: orderIds ? { in: orderIds } : { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const m = new Map<string, { collected: number; deposited: number; collectedAt: Date | null; deposits: { amount: number; reference: string | null; at: Date; by: string | null }[] }>();
    for (const e of rows) {
      const a = m.get(e.orderId) || { collected: 0, deposited: 0, collectedAt: null, deposits: [] };
      if (e.type === 'COD_COLLECTION') { a.collected = r2(a.collected - n(e.amount)); a.collectedAt = a.collectedAt || e.createdAt; }
      else { a.deposited = r2(a.deposited + n(e.amount)); a.deposits.push({ amount: n(e.amount), reference: e.reference, at: e.createdAt, by: e.createdBy }); }
      m.set(e.orderId, a);
    }
    return m;
  }

  /** Admin records a verified cash deposit by an in-house technician against one job. */
  async recordEmployeeCashDeposit(actor: { sub: string; role: UserRole }, b: { vendorId: string; orderId: string; amount: number; reference: string; note?: string }) {
    const amount = r2(Number(b?.amount));
    const reference = String(b?.reference || '').trim();
    if (!(amount > 0)) throw new BadRequestException('Enter the deposited amount');
    if (!reference) throw new BadRequestException('A deposit reference (receipt / bank slip number) is required');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ServiceVendor" WHERE id = ${b.vendorId} FOR UPDATE`;
      const vendor = await tx.serviceVendor.findUnique({ where: { id: b.vendorId }, select: { id: true, staffType: true } });
      if (!vendor) throw new NotFoundException('Technician not found');
      if (vendor.staffType !== 'IN_HOUSE') throw new BadRequestException('Cash deposits are recorded for in-house technicians only — partner cash is settled through the partner wallet');
      const order = await tx.order.findUnique({ where: { id: b.orderId }, select: { id: true, vendorId: true, orderNumber: true } });
      if (!order || order.vendorId !== vendor.id) throw new BadRequestException('This job was not done by this technician');
      // the same receipt never counts twice (a retried request returns the deposit already recorded)
      const dup = await tx.partnerLedgerEntry.findFirst({ where: { vendorId: vendor.id, type: 'CASH_DEPOSIT', reference } });
      if (dup) {
        if (dup.orderId === order.id && r2(n(dup.amount)) === amount) return { alreadyRecorded: true, entryId: dup.id };
        throw new ConflictException(`Deposit reference ${reference} is already recorded`);
      }
      const pos = (await this.employeeCashByOrder(tx, vendor.id, [order.id])).get(order.id) || { collected: 0, deposited: 0 };
      const outstanding = r2(pos.collected - pos.deposited);
      if (outstanding <= 0) throw new BadRequestException('No verified cash is outstanding on this job');
      if (amount > outstanding) throw new BadRequestException(`Deposit exceeds the cash outstanding on this job (₹${outstanding})`);
      const entry = await this.ledger.postEntry(tx, vendor.id, 'CASH_DEPOSIT' as any, amount, {
        orderId: order.id, reference, createdBy: actor.sub,
        notes: `Cash deposited with Remont for ${order.orderNumber} (ref ${reference})${b.note ? ': ' + String(b.note).trim() : ''}`,
      });
      await tx.serviceVendor.update({ where: { id: vendor.id }, data: { pendingPayout: { increment: amount } } });
      await logAudit(tx, { actorId: actor.sub, actorRole: actor.role, action: 'EMPLOYEE_CASH_DEPOSIT', targetType: 'Order', targetId: order.id, metadata: { vendorId: vendor.id, amount, reference, ledgerEntryId: entry.id } });
      return { recorded: true, entryId: entry.id, outstandingAfter: r2(outstanding - amount) };
    }, { timeout: 15000, maxWait: 10000 });
  }

  /** Every in-house job with cash collected: collected, deposited, outstanding (rows, for screen and workbook). */
  async employeeCashRows(range: DateRange) {
    const techs = await this.prisma.serviceVendor.findMany({ where: { staffType: 'IN_HOUSE' }, select: { id: true, fullName: true } });
    const out: any[] = [];
    for (const t of techs) {
      const byOrder = await this.employeeCashByOrder(this.prisma, t.id);
      if (!byOrder.size) continue;
      const orders = await this.prisma.order.findMany({
        where: { id: { in: [...byOrder.keys()] } },
        select: { id: true, orderNumber: true, completedAt: true, slotStart: true, paymentMethod: true, invoice: { select: { invoiceNumber: true } } },
      });
      const pays = await this.prisma.paymentTransaction.findMany({
        where: { orderId: { in: [...byOrder.keys()] }, gateway: 'CASH_COLLECTION' },
        select: { orderId: true, collectionMode: true, status: true, verificationMethod: true },
      });
      for (const o of orders) {
        const a = byOrder.get(o.id)!;
        if (range.from && a.collectedAt && a.collectedAt < range.from) continue;
        if (range.to && a.collectedAt && a.collectedAt > range.to) continue;
        const p = pays.filter((x) => x.orderId === o.id);
        out.push({
          technicianId: t.id, technician: t.fullName, orderId: o.id, orderNumber: o.orderNumber,
          serviceDate: o.completedAt || o.slotStart, invoiceNumber: o.invoice?.invoiceNumber || '',
          collected: a.collected, collectedAt: a.collectedAt,
          method: [...new Set(p.map((x) => x.collectionMode).filter(Boolean))].join(', ') || o.paymentMethod || '',
          verification: [...new Set(p.filter((x) => x.status === 'PAID').map((x) => x.verificationMethod).filter(Boolean))].join(', '),
          deposited: a.deposited, depositRefs: a.deposits.map((x) => x.reference).filter(Boolean).join(', '),
          outstanding: r2(a.collected - a.deposited),
        });
      }
    }
    return out.sort((x, y) => String(x.technician).localeCompare(String(y.technician)) || +new Date(x.collectedAt) - +new Date(y.collectedAt));
  }

  async employeeCashReport(range: DateRange) {
    const rows = await this.employeeCashRows(range);
    const wb = new Excel.Workbook();
    addSheet(wb, 'Employee cash', [['Technician', 'technician', 22], ['Technician ID', 'technicianId', 28], ['Order', 'orderNumber', 24], ['Service date', 'serviceDate', 12], ['Invoice', 'invoiceNumber', 24], ['Collected', 'collected'], ['Collected on', 'collectedAt', 12], ['Method', 'method', 12], ['Verified by', 'verification', 14], ['Deposited', 'deposited'], ['Deposit refs', 'depositRefs', 24], ['Outstanding', 'outstanding']],
      rows.map((r) => ({ ...r, serviceDate: d(r.serviceDate), collectedAt: d(r.collectedAt) })),
      'Cash collected by Remont\'s in-house technicians on Remont\'s behalf, and its verified deposit. Not salary, not partner earnings.');
    const byTech = new Map<string, any>();
    for (const r of rows) { const a = byTech.get(r.technicianId) || { technician: r.technician, jobs: 0, collected: 0, deposited: 0, outstanding: 0 }; a.jobs++; a.collected = r2(a.collected + r.collected); a.deposited = r2(a.deposited + r.deposited); a.outstanding = r2(a.outstanding + r.outstanding); byTech.set(r.technicianId, a); }
    addSheet(wb, 'By technician', [['Technician', 'technician', 22], ['Jobs', 'jobs', 8], ['Collected', 'collected'], ['Deposited', 'deposited'], ['Outstanding', 'outstanding']], [...byTech.values()]);
    return toBuffer(wb);
  }

  listPurchases(range: DateRange) {
    return this.prisma.purchaseRecord.findMany({ where: { invoiceDate: within(range) }, orderBy: { invoiceDate: 'desc' }, take: 500 });
  }
}

function send(res: Response, buf: Buffer, name: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
}
const tag = (from?: string, to?: string) => `${from || 'start'}_to_${to || 'today'}`;

@ApiTags('Admin Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/accounting')
export class AccountingReportsController {
  constructor(private r: AccountingReportsService) {}
  @Get('sales-register') async sales(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.salesRegister(parseRange(f, t)), `sales-register_${tag(f, t)}.xlsx`); }
  @Get('purchase-register') async purchases(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.purchaseRegister(parseRange(f, t)), `purchase-register_${tag(f, t)}.xlsx`); }
  @Get('gstr1') async gstr1(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.gstr1(parseRange(f, t)), `gstr1-reconciliation-aid_${tag(f, t)}.xlsx`); }
  @Get('gstr3b') async gstr3b(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.gstr3b(parseRange(f, t)), `gstr3b-reconciliation-aid_${tag(f, t)}.xlsx`); }
  @Get('gst-summary') gstSummary(@Query('from') f: string, @Query('to') t: string) { return this.r.gstSummaryData(parseRange(f, t)); }
  @Get('gst-payable') async gstPayable(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.gstPayable(parseRange(f, t)), `gst-payable_${tag(f, t)}.xlsx`); }
  @Get('revenue') async revenue(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.revenueReport(parseRange(f, t)), `revenue-commission_${tag(f, t)}.xlsx`); }
  @Get('profitability') async profit(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.profitability(parseRange(f, t)), `profitability_${tag(f, t)}.xlsx`); }
  @Get('refunds') async refunds(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.refundsReport(parseRange(f, t)), `refunds-credit-notes_${tag(f, t)}.xlsx`); }
  @Get('settlements') async settlements(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.settlementsReport(parseRange(f, t)), `settlements_${tag(f, t)}.xlsx`); }
  @Get('gateway-fees') async fees(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.gatewayFeesReport(parseRange(f, t)), `gateway-fees_${tag(f, t)}.xlsx`); }
  @Get('test-payments') async test(@Res() res: Response) { const { buffer } = await this.r.testPayments(); send(res, buffer, 'test-gateway-payments.xlsx'); }
  @Get('test-payments/summary') async testSummary() { return (await this.r.testPayments()).summary; }
  @Get('partner-payout-reconciliation') payoutRecon() { return this.r.partnerPayoutReconciliation(); }
  @Get('e-invoice-status') eInvoiceStatus() { return this.r.eInvoiceStatus(); }
  @Roles(UserRole.SUPER_ADMIN)
  @Post('partner-payout-reconciliation/:vendorId/correct')
  correct(@CurrentUser() u: JwtPayload, @Param('vendorId') id: string, @Body() b: { amount: number; expectedDifference: number; reason: string; orderId?: string }) {
    return this.r.correctPartnerLedger({ sub: u.sub, role: u.role }, id, b);
  }
  @Get('employee-cash') async employeeCash(@Query('from') f: string, @Query('to') t: string, @Res() res: Response) { send(res, await this.r.employeeCashReport(parseRange(f, t)), `employee-cash_${tag(f, t)}.xlsx`); }
  @Get('employee-cash/rows') employeeCashRows(@Query('from') f: string, @Query('to') t: string) { return this.r.employeeCashRows(parseRange(f, t)); }
  @Post('employee-cash/deposits') employeeCashDeposit(@CurrentUser() u: JwtPayload, @Body() b: { vendorId: string; orderId: string; amount: number; reference: string; note?: string }) {
    return this.r.recordEmployeeCashDeposit({ sub: u.sub, role: u.role }, b);
  }
  @Get('purchases') listPurchases(@Query('from') f: string, @Query('to') t: string) { return this.r.listPurchases(parseRange(f, t)); }
  @Post('purchases') createPurchase(@CurrentUser() u: JwtPayload, @Body() b: any) { return this.r.createPurchase(u.sub, b); }
}
