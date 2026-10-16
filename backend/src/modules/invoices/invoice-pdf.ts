import PDFDocument from 'pdfkit';
import type { BillingCompanyConfig } from '../../common';
import { stateFromGstin } from '../../common/billing-engine';

// ═══════════════════════════════════════════════════════════════════════════
// Invoice PDF rendering — one shared layout (this file), fed by a view model
// assembled per transaction type/page in buildInvoiceViewModel() below, so the
// visual design stays identical across all 3 transaction types (§8 of the
// billing spec) and only the conditional blocks (badge, entity, line items,
// GST-vs-no-GST footer) differ. No second PDF library, no per-type template.
// ═══════════════════════════════════════════════════════════════════════════

export type InvoiceDocKind = 'CUSTOMER' | 'VENDOR' | 'REMONT';

interface PartyBlock {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  state?: string | null;
}

interface LineItemView {
  description: string;
  hsnSac: string | null;
  qty: number;
  unit: string;
  rate: number;
  discount: number;
  taxRatePercent: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  amount: number;
}

interface InvoiceViewModel {
  isTaxInvoice: boolean; // false => plain "Receipt", no GST claimed
  // true only for the Type-1 customer booking summary — distinguishes "not a tax
  // invoice, but shows a real GST figure for transparency" from "not a tax invoice
  // because nothing is GST-registered here at all" (the vendor no-GSTIN receipt case).
  isInformationalSummary?: boolean;
  docBadge: string;
  copyTag: string;
  invoiceNumber: string;
  invoiceDate: Date;
  placeOfSupply: string;
  supplier: PartyBlock;
  recipient: PartyBlock;
  lines: LineItemView[];
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  discount: number;
  roundOff: number;
  total: number;
  received: number;
  bank?: { name: string; ifsc: string; accountNumber: string } | null;
  termsAndConditions: string[];
  /** Explanatory notes printed under the totals (legal basis, who invoices what). */
  notes?: string[];
  /** Customer pages only — what was actually received, and how. */
  payment?: { received: number; reference: string | null } | null;
  numberLabel?: string;
  dateLabel?: string;
  /** Who signs. Defaults to the supplier; a statement Remont only prepared is never signed in the partner's name. */
  signatory?: string;
  /** e.g. "Against invoice INV-CTI-2026-000012 dated 01/10/2026" on a credit note */
  referenceLine?: string | null;
}

/** What the customer actually paid for an order (computed by InvoicesService from real payments). */
export interface InvoicePaymentInfo { received: number; reference: string | null }

const SECTION_95_BASIS = 'section 9(5) of the CGST Act, 2017';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitsToWords(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function threeDigitsToWords(n: number): string {
  if (n < 100) return twoDigitsToWords(n);
  return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + twoDigitsToWords(n % 100) : '');
}

/** Indian numbering (Lakh/Crore) amount-in-words, matching the reference invoice's
 * "Three Thousand Rupees" style footer. */
export function amountInWords(amount: number): string {
  const totalPaise = Math.round(Number(amount) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  if (rupees === 0) return `${twoDigitsToWords(paise)} Paise Only`;
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n;
  if (crore) parts.push(threeDigitsToWords(crore) + ' Crore');
  if (lakh) parts.push(threeDigitsToWords(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigitsToWords(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigitsToWords(hundred));
  return parts.join(' ') + ' Rupees' + (paise ? ` and ${twoDigitsToWords(paise)} Paise` : '') + ' Only';
}

function rupees(n: number): string {
  return `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Assembles what to print for a given (invoice, docKind) — which page is the operative
 * legal tax invoice vs an informational/settlement document depends on transactionType,
 * per §3/§8 of the billing spec:
 *   PLATFORM_SERVICE:  CUSTOMER = informational summary, VENDOR = partner settlement
 *                       (tax invoice only if partner has a GSTIN), REMONT = the actual
 *                       Remont tax invoice (platform fee only).
 *   DIRECT_PROJECT:     CUSTOMER = the sole tax invoice (full project value).
 *   MARKETPLACE_PRODUCT: CUSTOMER = the seller's product tax invoice, REMONT = Remont's
 *                       commission invoice to the seller.
 */
export function buildInvoiceViewModel(
  invoice: any,
  docKind: InvoiceDocKind,
  ctx: { company: BillingCompanyConfig; order: any; payment?: InvoicePaymentInfo | null },
): InvoiceViewModel {
  const { company, order } = ctx;
  const partnerName: string = order.vendor?.businessName || order.vendor?.fullName || 'the partner';
  const customerBlock: PartyBlock = {
    name: order.masterOrder?.customerGstName || order.customer?.name || order.guestName || 'Customer',
    address: order.snapshotAddressLine,
    phone: order.customer?.phone || order.guestPhone,
    email: order.customer?.email || order.guestEmail,
    gstin: order.masterOrder?.customerGstin || null,
    state: order.snapshotState,
  };
  const companyBlock: PartyBlock = {
    name: company.legalName, address: company.address, phone: company.mobile,
    email: company.email, gstin: company.gstin, state: company.state,
  };
  const lineSnapshot = invoice.lineItemsSnapshot || { customer: [], vendor: [], remont: [] };
  const bank = { name: company.bankName, ifsc: company.bankIfsc, accountNumber: company.bankAccountNumber };

  // C-05 — an issued invoice's party identity (names/address/GSTIN/state) must never
  // drift just because someone later edits the seller's/customer's/Remont's own master-
  // data row. generateForOrder() (invoices.module.ts) calls this same function once, at
  // generation time, and freezes its supplier/recipient output onto
  // invoice.lineItemsSnapshot.parties[docKind] — every render after that prefers the
  // frozen block over the live order/company relations below. A pre-existing invoice
  // (generated before this fix shipped) simply has no `parties` key, so it falls through
  // to the live derivation exactly as it always has — never retroactively frozen.
  const frozenPartyKey = docKind === 'VENDOR' ? 'vendor' : docKind === 'REMONT' ? 'remont' : 'customer';
  const frozenParties = invoice.lineItemsSnapshot?.parties?.[frozenPartyKey] as { supplier?: PartyBlock; recipient?: PartyBlock } | undefined;

  // A category-level workmanship warranty (ServiceCategory.warrantyDays) only makes
  // sense on documents where Remont itself (not a marketplace seller) is on the hook for
  // the work — surfaced as a visible term rather than left implicit.
  const warrantyDays: number | null = order.service?.category?.warrantyDays ?? null;
  const warrantyLine = warrantyDays
    ? `This service carries a ${warrantyDays}-day workmanship warranty from the date of completion, covering workmanship only.`
    : null;

  // Model 1 (partner job issued after the two-document fix): issuance mode + commission basis
  // frozen at issue. Absent on older invoices, which keep rendering exactly as they were issued.
  const partnerDoc = lineSnapshot.partnerDocument as
    | { issuance: 'STATEMENT' | 'ON_BEHALF'; partnerRegistered: boolean; serviceDate: string | null; commission: { amount: number; base: number; ruleLabel: string | null; gstRatePercent: number } }
    | undefined;
  const fmtDate = (d: any) => (d ? new Date(d).toLocaleDateString('en-IN') : null);

  if (docKind === 'VENDOR' && partnerDoc) {
    // Invoice A — the partner's supply of the service to the customer. The partner is the supplier;
    // Remont never appears as the supplier. Whether this page is the partner's tax invoice depends on
    // the issuance authority frozen at issue (see InvoicesService.partnerInvoiceIssuance).
    const registered = partnerDoc.partnerRegistered;
    const onBehalf = partnerDoc.issuance === 'ON_BEHALF';
    const p = order.partnerProfile;
    const gstin = registered ? String(order.vendor?.gstin).trim().toUpperCase() : null;
    const liveSupplier: PartyBlock = {
      name: order.vendor?.businessName || order.vendor?.fullName || 'Partner',
      address: p ? [p.fullAddress, p.city, p.pincode].filter(Boolean).join(', ') || null : null,
      gstin,
      state: stateFromGstin(gstin) || p?.state || null,
    };
    const taxable = Number(invoice.vendorLabor), cgst = Number(invoice.vendorCgst), sgst = Number(invoice.vendorSgst);
    const total = Number(invoice.vendorTotal);
    // IGST has no column of its own; it is whatever the stored total holds beyond taxable + CGST + SGST.
    const igst = Math.max(0, Math.round((total - taxable - cgst - sgst) * 100) / 100);
    const notes: string[] = [];
    if (onBehalf) notes.push(`Issued by ${company.legalName} on behalf of ${partnerName}, the supplier of this service, under the partner's authorisation. ${company.legalName} is not the supplier of this service.`);
    else notes.push(`Prepared by ${company.legalName} for the service supplied to you by ${partnerName}. ${company.legalName} is not the supplier of this service.${registered ? ` The partner (GSTIN ${gstin}) issues its own tax invoice for this service and is liable for the GST shown.` : ''}`);
    if (invoice.section95) notes.push(`The partner is not registered under GST and charges no GST. GST on this service is paid by ${company.legalName} as electronic commerce operator under ${SECTION_95_BASIS} (customer tax invoice ${invoice.invoiceNumber}).`);
    else if (!registered) notes.push('The partner is not registered under GST and charges no GST on this document.');
    const isTax = registered && onBehalf;
    return {
      isTaxInvoice: isTax,
      isInformationalSummary: registered && !onBehalf,
      docBadge: isTax ? 'TAX INVOICE' : registered ? 'PARTNER SERVICE STATEMENT — NOT A TAX INVOICE' : 'PARTNER SERVICE RECEIPT — NO GST CHARGED',
      copyTag: onBehalf ? 'ORIGINAL FOR RECIPIENT — ISSUED ON BEHALF OF THE PARTNER' : 'SERVICE SUPPLIED BY THE PARTNER',
      numberLabel: isTax ? 'Invoice No.' : 'Document No.',
      dateLabel: isTax ? 'Invoice Date' : 'Date',
      signatory: onBehalf ? `For ${partnerName} — issued by ${company.legalName} on the partner's behalf` : `Prepared by ${company.legalName} — not signed on behalf of the partner`,
      invoiceNumber: invoice.vendorDocumentNumber || invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
      referenceLine: `Order ${order.orderNumber}${partnerDoc.serviceDate ? ` · Service date ${fmtDate(partnerDoc.serviceDate)}` : ''}`,
      placeOfSupply: invoice.placeOfSupply || customerBlock.state || '',
      supplier: frozenParties?.supplier ?? liveSupplier,
      recipient: frozenParties?.recipient ?? customerBlock,
      lines: lineSnapshot.vendor || [],
      taxableValue: taxable, cgst, sgst, igst,
      discount: 0, roundOff: 0, total, received: 0, bank: null,
      termsAndConditions: [],
      notes,
    };
  }

  if (docKind === 'VENDOR') {
    // Partner Service Invoice — issued in the partner's own name for the partner's
    // share only. Never assumed to be a GST tax invoice: an unregistered partner (the
    // common case) gets a plain receipt, never a fabricated GST breakup.
    const vendorRegistered = !!order.vendor?.gstin;
    return {
      isTaxInvoice: vendorRegistered,
      docBadge: vendorRegistered ? 'TAX INVOICE' : 'RECEIPT — NO GST APPLIES',
      copyTag: vendorRegistered ? 'PARTNER SERVICE INVOICE' : 'PARTNER SERVICE RECEIPT',
      // C-08 — this partner document is legally distinct from the customer/Remont pages
      // and gets its own number/series (see Invoice.vendorDocumentNumber). Falls back to
      // the shared invoiceNumber only for an invoice generated before this field existed
      // — never retroactively renumbered.
      invoiceNumber: invoice.vendorDocumentNumber || invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
      placeOfSupply: invoice.placeOfSupply || customerBlock.state || '',
      supplier: frozenParties?.supplier ?? { name: order.vendor?.fullName || order.vendor?.businessName || 'Partner', gstin: order.vendor?.gstin || null },
      recipient: frozenParties?.recipient ?? customerBlock,
      lines: lineSnapshot.vendor || [],
      taxableValue: Number(invoice.vendorLabor), cgst: Number(invoice.vendorCgst), sgst: Number(invoice.vendorSgst), igst: 0,
      discount: 0, roundOff: 0, total: Number(invoice.vendorTotal), received: 0, bank: null,
      termsAndConditions: [],
      notes: invoice.section95
        ? [`The partner is not registered under GST and charges no GST. GST on this service is paid by ${company.legalName} as electronic commerce operator under ${SECTION_95_BASIS} (customer tax invoice ${invoice.invoiceNumber}).`]
        : [],
    };
  }

  if (docKind === 'REMONT') {
    const isMarketplace = invoice.transactionType === 'MARKETPLACE_PRODUCT';
    const sellerVendor = isMarketplace ? order.items?.find((it: any) => it.product?.vendor)?.product?.vendor : null;
    const isPartnerJob = invoice.transactionType === 'PLATFORM_SERVICE' && !!order.vendor;
    const liveRecipient: PartyBlock = isMarketplace && sellerVendor
      ? { name: sellerVendor.businessName, address: sellerVendor.address, gstin: sellerVendor.gstNumber, state: sellerVendor.state }
      // Commission is deducted from the partner, so the partner receives Remont's commission document.
      : isPartnerJob
        ? { name: order.vendor.businessName || order.vendor.fullName || 'Partner', gstin: order.vendor.gstin || null }
        : customerBlock;
    const recipient = frozenParties?.recipient ?? liveRecipient;
    return {
      isTaxInvoice: true,
      docBadge: 'TAX INVOICE',
      copyTag: isMarketplace ? 'ORIGINAL FOR SELLER — MARKETPLACE COMMISSION' : isPartnerJob ? 'ORIGINAL FOR PARTNER — REMONT COMMISSION' : 'ORIGINAL FOR RECIPIENT — PLATFORM FEE',
      // C-08 — Remont's own platform-fee/commission document is a legally distinct
      // instrument from the customer's (and, for a marketplace order, the seller's own)
      // tax invoice — never the same number (see Invoice.remontDocumentNumber). Falls
      // back to the shared invoiceNumber only for a pre-Phase-5 invoice.
      invoiceNumber: invoice.remontDocumentNumber || invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
      placeOfSupply: recipient.state || invoice.placeOfSupply || '',
      supplier: frozenParties?.supplier ?? companyBlock,
      recipient,
      lines: lineSnapshot.remont || [],
      taxableValue: Number(invoice.platformCommission) + Number(invoice.bookingFee),
      cgst: Number(invoice.remontCgst), sgst: Number(invoice.remontSgst), igst: Number(invoice.remontIgst),
      discount: 0, roundOff: 0, total: Number(invoice.remontTotal), received: 0, bank,
      termsAndConditions: company.invoiceTerms, // Remont is always the supplier on this page
      // Invoice B (Model 1): linked to the order and the partner's document, with the commission basis.
      ...(isPartnerJob && partnerDoc
        ? {
            referenceLine: `Order ${order.orderNumber} · Partner document ${invoice.vendorDocumentNumber || '—'}`,
            notes: [
              `Commission on the service value of ${rupees(partnerDoc.commission.base)}${partnerDoc.commission.ruleLabel ? ` (${partnerDoc.commission.ruleLabel})` : ''}: ${rupees(partnerDoc.commission.amount)}, plus GST at ${partnerDoc.commission.gstRatePercent}%.`,
              `Remont's charge to the partner for the use of the platform on this order. It is not part of the service supplied to the customer.`,
            ],
          }
        : {}),
    };
  }

  // CUSTOMER page
  // Section 9(5): for a partner job by an UNREGISTERED partner in an eligible category, Remont
  // (the e-commerce operator) is the person liable for the GST and issues the tax invoice itself.
  const isSection95 = invoice.transactionType === 'PLATFORM_SERVICE' && !!invoice.section95;
  const isSummaryOnly = invoice.transactionType === 'PLATFORM_SERVICE' && !isSection95;
  const isMarketplace = invoice.transactionType === 'MARKETPLACE_PRODUCT';
  const sellerVendor = isMarketplace ? order.items?.find((it: any) => it.product?.vendor)?.product?.vendor : null;
  const remontIsSupplier = !isMarketplace || !sellerVendor;
  const liveSupplier: PartyBlock = isMarketplace && sellerVendor
    ? { name: sellerVendor.businessName, address: sellerVendor.address, gstin: sellerVendor.gstNumber, state: sellerVendor.state }
    : companyBlock;
  return {
    isTaxInvoice: !isSummaryOnly,
    isInformationalSummary: isSummaryOnly,
    docBadge: isSummaryOnly ? 'BOOKING SUMMARY — NOT A GST INVOICE' : 'TAX INVOICE',
    copyTag: isSection95 ? 'ORIGINAL FOR RECIPIENT — ISSUED UNDER SECTION 9(5)' : 'ORIGINAL FOR RECIPIENT',
    invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
    placeOfSupply: invoice.placeOfSupply || '',
    supplier: frozenParties?.supplier ?? liveSupplier,
    recipient: frozenParties?.recipient ?? customerBlock,
    lines: lineSnapshot.customer || [],
    taxableValue: Number(invoice.customerSubtotal), cgst: Number(invoice.customerCgst), sgst: Number(invoice.customerSgst), igst: Number(invoice.customerIgst),
    discount: Number(invoice.discount), roundOff: Number(invoice.roundOff), total: Number(invoice.customerTotal),
    received: ctx.payment?.received ?? 0, bank: isSummaryOnly ? null : bank,
    payment: ctx.payment ?? null,
    notes: customerNotes(),
    // Remont's own boilerplate (Bhopal jurisdiction, "Remont's own taxable supply", etc.)
    // only belongs on a document where Remont is actually the invoicing entity — not on
    // a marketplace seller's own product invoice, where printing Remont's terms as if
    // they were the seller's would be misleading.
    termsAndConditions: isSummaryOnly
      ? []
      : remontIsSupplier
        ? [...company.invoiceTerms, ...(warrantyLine ? [warrantyLine] : [])]
        : [],
  };

  function customerNotes(): string[] {
    if (isSection95) {
      return [`Tax invoice issued by ${company.legalName} as electronic commerce operator under ${SECTION_95_BASIS} for a service supplied through the Remont platform. Service performed by ${partnerName}, who is not registered under GST.`];
    }
    if (!isSummaryOnly) return [];
    const fee = (lineSnapshot.customer || []).some((l: any) => /platform fee/i.test(l.description || ''));
    const feeNote = fee ? ' The Remont Platform Fee is invoiced separately by ' + company.legalName + '.' : '';
    if (invoice.taxReviewRequired) {
      return ['This is a booking summary, not a GST tax invoice. It shows the amounts you paid, including the GST collected at booking; ' + company.legalName + ' will issue the applicable tax document for that GST.' + feeNote];
    }
    if (partnerDoc?.partnerRegistered) {
      return [`This is a booking summary, not a GST tax invoice. The service is supplied by ${partnerName} (GSTIN ${String(order.vendor?.gstin).trim().toUpperCase()}), who is liable for the GST shown above${partnerDoc.issuance === 'ON_BEHALF' ? ` — see the partner's tax invoice ${invoice.vendorDocumentNumber}` : ` and issues its own tax invoice for it (summarised in partner document ${invoice.vendorDocumentNumber})`}.` + feeNote];
    }
    if (order.vendor?.gstin && !partnerDoc) {
      return [`This is a booking summary, not a GST tax invoice. The service is supplied by ${partnerName} (GSTIN ${order.vendor.gstin}), whose tax invoice${invoice.vendorDocumentNumber ? ' ' + invoice.vendorDocumentNumber : ''} carries the GST shown above.` + feeNote];
    }
    return ['This is a booking summary, not a GST tax invoice. It shows the amounts you paid for this booking.' + feeNote];
  }
}

/**
 * A credit note page — reverses (part of) the CUSTOMER document of an invoice. A credit note
 * against a booking summary (not itself a tax invoice) is labelled a refund note, not a GST
 * credit note, for the same reason the summary is not a tax invoice.
 */
export function buildCreditNoteViewModel(
  creditNote: any,
  invoice: any,
  ctx: { company: BillingCompanyConfig; order: any },
): InvoiceViewModel {
  const base = buildInvoiceViewModel(invoice, 'CUSTOMER', { company: ctx.company, order: ctx.order });
  const taxable = Number(creditNote.taxableValueReversed);
  const cgst = Number(creditNote.cgstReversed), sgst = Number(creditNote.sgstReversed), igst = Number(creditNote.igstReversed);
  const total = Number(creditNote.totalReversed);
  const gst = cgst + sgst + igst;
  const rate = taxable > 0 ? Math.round((gst / taxable) * 1000) / 10 : 0;
  const original = creditNote.originalInvoiceNumber || invoice.invoiceNumber;
  const isCancellation = creditNote.kind === 'INVOICE_CANCELLATION';
  return {
    ...base,
    docBadge: base.isTaxInvoice ? 'CREDIT NOTE' : 'REFUND NOTE — NOT A GST CREDIT NOTE',
    copyTag: isCancellation ? 'CANCELLATION OF ISSUED INVOICE' : 'ORIGINAL FOR RECIPIENT',
    numberLabel: 'Credit Note No.',
    dateLabel: 'Date',
    invoiceNumber: creditNote.creditNoteNumber,
    invoiceDate: creditNote.issuedAt,
    referenceLine: `Against invoice ${original} dated ${new Date(invoice.generatedAt).toLocaleDateString('en-IN')}`,
    lines: [{
      description: isCancellation ? `Cancellation of invoice ${original}` : `Refund: ${creditNote.reason}`,
      hsnSac: null, qty: 1, unit: '', rate: taxable, discount: 0, taxRatePercent: rate,
      taxableValue: taxable, cgst, sgst, igst, amount: total,
    }],
    taxableValue: taxable, cgst, sgst, igst, discount: 0, roundOff: Math.round((total - taxable - gst) * 100) / 100, total,
    received: 0, payment: null, bank: null, termsAndConditions: [],
    notes: isCancellation
      ? [`This credit note cancels invoice ${original} (net of any earlier credit notes) because it was reissued with corrected details: ${creditNote.reason}`]
      : ['Reverses the value refunded against the invoice above. The original invoice is not altered.'],
  };
}

export type InvoicePdfPage =
  | { kind: 'INVOICE'; invoice: any; docKind: InvoiceDocKind }
  | { kind: 'CREDIT_NOTE'; invoice: any; creditNote: any };

export async function renderInvoicePdf(
  invoice: any,
  docKind: InvoiceDocKind,
  ctx: { company: BillingCompanyConfig; order: any; payment?: InvoicePaymentInfo | null },
): Promise<Buffer> {
  return renderInvoiceBundlePdf([{ kind: 'INVOICE', invoice, docKind }], ctx);
}

/** One PDF with several documents (combined download), each on its own page. */
export async function renderInvoiceBundlePdf(
  pages: InvoicePdfPage[],
  ctx: { company: BillingCompanyConfig; order: any; payment?: InvoicePaymentInfo | null },
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  pages.forEach((pg, i) => {
    if (i > 0) doc.addPage();
    const vm = pg.kind === 'INVOICE'
      ? buildInvoiceViewModel(pg.invoice, pg.docKind, { ...ctx, payment: pg.docKind === 'CUSTOMER' ? ctx.payment : null })
      : buildCreditNoteViewModel(pg.creditNote, pg.invoice, ctx);
    drawInvoicePage(doc, vm);
  });
  doc.end();
  return done;
}

function drawInvoicePage(doc: PDFKit.PDFDocument, vm: InvoiceViewModel) {
  const pageWidth = doc.page.width - 80;

  // ── Badge + copy tag ──
  doc.fontSize(14).fillColor('#111').text(vm.docBadge, 40, 40, { continued: false });
  doc.fontSize(8).fillColor('#666').text(vm.copyTag, 40, 58);

  // ── Supplier entity block ──
  doc.fontSize(12).fillColor('#111').text(vm.supplier.name, 40, 80, { width: pageWidth, align: 'right' });
  doc.fontSize(8).fillColor('#444');
  const supplierLines = [vm.supplier.address, vm.supplier.phone ? `Mobile: ${vm.supplier.phone}` : null,
    vm.supplier.gstin ? `GSTIN: ${vm.supplier.gstin}` : null, vm.supplier.email].filter(Boolean) as string[];
  supplierLines.forEach((line, i) => doc.text(line, 40, 98 + i * 12, { width: pageWidth, align: 'right' }));

  let y = 98 + supplierLines.length * 12 + 16;

  // ── Grey info bar ──
  doc.rect(40, y, pageWidth, 22).fill('#f0f0f0');
  doc.fillColor('#111').fontSize(9)
    .text(`${vm.numberLabel || 'Invoice No.'}: ${vm.invoiceNumber}`, 46, y + 6)
    .text(`${vm.dateLabel || 'Invoice Date'}: ${new Date(vm.invoiceDate).toLocaleDateString('en-IN')}`, 40, y + 6, { width: pageWidth - 6, align: 'right' });
  y += 34;
  if (vm.referenceLine) {
    doc.fontSize(9).fillColor('#111').text(vm.referenceLine, 40, y, { width: pageWidth });
    y += 18;
  }

  // ── Bill To / Place of Supply ──
  doc.fontSize(9).fillColor('#111').text('Bill To:', 40, y);
  doc.fontSize(9).fillColor('#444').text(vm.recipient.name, 40, y + 12);
  const recipientLines = [vm.recipient.address, vm.recipient.phone, vm.recipient.gstin ? `GSTIN: ${vm.recipient.gstin}` : null]
    .filter(Boolean) as string[];
  recipientLines.forEach((line, i) => doc.text(line, 40, y + 24 + i * 12, { width: pageWidth / 2 - 10 }));
  doc.fontSize(9).fillColor('#111').text(`Place of Supply: ${vm.placeOfSupply}`, 40 + pageWidth / 2, y, { width: pageWidth / 2 });
  y += 24 + Math.max(recipientLines.length, 1) * 12 + 14;

  // ── Line items table ──
  const cols = [
    { key: 'description', label: 'Item', width: pageWidth * 0.30 },
    { key: 'hsnSac', label: 'HSN/SAC', width: pageWidth * 0.12 },
    { key: 'qty', label: 'Qty', width: pageWidth * 0.08 },
    { key: 'rate', label: 'Rate', width: pageWidth * 0.13 },
    { key: 'taxRatePercent', label: 'Tax %', width: pageWidth * 0.10 },
    { key: 'amount', label: 'Amount', width: pageWidth * 0.27 },
  ];
  doc.rect(40, y, pageWidth, 18).fill('#e8e8e8');
  let x = 40;
  doc.fillColor('#111').fontSize(8);
  for (const c of cols) { doc.text(c.label, x + 3, y + 5, { width: c.width - 6 }); x += c.width; }
  y += 18;

  for (const line of vm.lines) {
    const rowH = 16;
    x = 40;
    doc.fontSize(8).fillColor('#333');
    doc.text(line.description, x + 3, y + 4, { width: cols[0].width - 6 }); x += cols[0].width;
    doc.text(line.hsnSac || '—', x + 3, y + 4, { width: cols[1].width - 6 }); x += cols[1].width;
    doc.text(String(line.qty), x + 3, y + 4, { width: cols[2].width - 6 }); x += cols[2].width;
    doc.text(rupees(line.rate), x + 3, y + 4, { width: cols[3].width - 6 }); x += cols[3].width;
    doc.text(vm.isTaxInvoice ? `${line.taxRatePercent}%` : '—', x + 3, y + 4, { width: cols[4].width - 6 }); x += cols[4].width;
    doc.text(rupees(line.amount), x + 3, y + 4, { width: cols[5].width - 6 });
    y += rowH;
    doc.moveTo(40, y).lineTo(40 + pageWidth, y).strokeColor('#ddd').stroke();
  }
  y += 10;

  // ── Totals block: bank details (left) vs taxable/tax/total (right) ──
  const totalsX = 40 + pageWidth * 0.55;
  const totalsW = pageWidth * 0.45;
  const rightLine = (label: string, value: string, bold = false) => {
    doc.fontSize(9).fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(label, totalsX, y, { width: totalsW * 0.55 });
    doc.text(value, totalsX + totalsW * 0.55, y, { width: totalsW * 0.45, align: 'right' });
    y += 14;
  };
  const totalsStartY = y;
  rightLine('Taxable Amount', rupees(vm.taxableValue));
  if (vm.isTaxInvoice) {
    if (vm.igst > 0) {
      rightLine('IGST', rupees(vm.igst));
    } else if (vm.cgst > 0 || vm.sgst > 0) {
      rightLine('CGST', rupees(vm.cgst));
      rightLine('SGST', rupees(vm.sgst));
    } else {
      rightLine('GST', 'Not applicable — unregistered');
    }
  } else if (vm.cgst > 0 || vm.sgst > 0 || vm.igst > 0) {
    // Booking summary: the GST actually collected at checkout, shown as charged — the note
    // below says which document (partner's / Remont's) is the tax invoice for it.
    rightLine('GST charged', rupees(vm.igst + vm.cgst + vm.sgst));
  } else {
    rightLine('GST', 'Not applicable');
  }
  // Phase 3 (M-04) — previously never rendered at all (vm.discount existed on the view
  // model but no totals row ever printed it, and vm.total never subtracted it either, so
  // the PDF's total silently disagreed with what the customer actually paid whenever a
  // coupon/membership discount applied). vm.total already has this netted in wherever
  // that's the correct treatment (see buildInvoiceBreakdown's discountReducesTaxableValue)
  // — this row is always just the transparent "here's the discount" disclosure.
  if (vm.discount > 0) rightLine('Discount', `- ${rupees(vm.discount)}`);
  if (vm.roundOff) rightLine('Round Off', rupees(vm.roundOff));
  rightLine('Total Amount', rupees(vm.total), true);
  // Only customer documents carry a payment position — a partner receipt / commission
  // invoice is settled through the partner ledger, so "balance due" there would be false.
  if (vm.payment) {
    rightLine('Received Amount', rupees(vm.payment.received));
    rightLine('Balance Due', rupees(Math.max(0, Math.round((vm.total - vm.payment.received) * 100) / 100)));
  }

  if (vm.bank) {
    let by = totalsStartY;
    doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text('Bank Details', 40, by); by += 14;
    doc.fontSize(8).fillColor('#444').font('Helvetica');
    doc.text(`Bank Name: ${vm.bank.name}`, 40, by); by += 12;
    doc.text(`IFSC: ${vm.bank.ifsc}`, 40, by); by += 12;
    doc.text(`Account No.: ${vm.bank.accountNumber}`, 40, by); by += 12;
  }

  y = Math.max(y, totalsStartY) + 20;
  doc.font('Helvetica').fontSize(8).fillColor('#333')
    .text(`Amount in words: ${amountInWords(vm.total)}`, 40, y, { width: pageWidth });
  y += 18;
  if (vm.payment?.reference) {
    doc.fontSize(8).fillColor('#333').text(`Payment: ${vm.payment.reference}`, 40, y, { width: pageWidth });
    y += 14;
  }
  y += 12;

  if (vm.notes?.length) {
    doc.fontSize(7).fillColor('#666');
    for (const note of vm.notes) {
      doc.text(note, 40, y, { width: pageWidth });
      y += doc.heightOfString(note, { width: pageWidth }) + 6;
    }
    y += 4;
  } else if (!vm.isTaxInvoice) {
    doc.fontSize(7).fillColor('#888')
      .text('This is a plain receipt — the invoicing entity is not GST-registered and no GST has been charged or claimed on this amount.', 40, y, { width: pageWidth });
    y += 20;
  }

  if (vm.termsAndConditions.length) {
    doc.fontSize(8).fillColor('#111').font('Helvetica-Bold').text('Terms & Conditions', 40, y, { width: pageWidth });
    y += 12;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    vm.termsAndConditions.forEach((term, i) => {
      doc.text(`${i + 1}. ${term}`, 40, y, { width: pageWidth });
      y += doc.heightOfString(`${i + 1}. ${term}`, { width: pageWidth }) + 3;
    });
    y += 10;
  }

  doc.fontSize(8).fillColor('#111').text(vm.signatory ?? `Authorised Signatory for ${vm.supplier.name}`, 40, y + 30, { width: pageWidth, align: 'right' });
}
