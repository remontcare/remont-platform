import PDFDocument from 'pdfkit';
import type { BillingCompanyConfig } from '../../common';

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
}

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
  const rupees = Math.round(amount);
  if (rupees === 0) return 'Zero Rupees Only';
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
  return parts.join(' ') + ' Rupees Only';
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
  ctx: { company: BillingCompanyConfig; order: any },
): InvoiceViewModel {
  const { company, order } = ctx;
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

  // A category-level workmanship warranty (ServiceCategory.warrantyDays) only makes
  // sense on documents where Remont itself (not a marketplace seller) is on the hook for
  // the work — surfaced as a visible term rather than left implicit.
  const warrantyDays: number | null = order.service?.category?.warrantyDays ?? null;
  const warrantyLine = warrantyDays
    ? `This service carries a ${warrantyDays}-day workmanship warranty from the date of completion, covering workmanship only.`
    : null;

  if (docKind === 'VENDOR') {
    // Partner Service Invoice — issued in the partner's own name for the partner's
    // share only. Never assumed to be a GST tax invoice: an unregistered partner (the
    // common case) gets a plain receipt, never a fabricated GST breakup.
    const vendorRegistered = !!order.vendor?.gstin;
    return {
      isTaxInvoice: vendorRegistered,
      docBadge: vendorRegistered ? 'TAX INVOICE' : 'RECEIPT — NO GST APPLIES',
      copyTag: vendorRegistered ? 'PARTNER SERVICE INVOICE' : 'PARTNER SERVICE RECEIPT',
      invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
      placeOfSupply: invoice.placeOfSupply || customerBlock.state || '',
      supplier: { name: order.vendor?.fullName || order.vendor?.businessName || 'Partner', gstin: order.vendor?.gstin || null },
      recipient: customerBlock,
      lines: lineSnapshot.vendor || [],
      taxableValue: Number(invoice.vendorLabor), cgst: Number(invoice.vendorCgst), sgst: Number(invoice.vendorSgst), igst: 0,
      discount: 0, roundOff: 0, total: Number(invoice.vendorTotal), received: 0, bank: null,
      termsAndConditions: [],
    };
  }

  if (docKind === 'REMONT') {
    const isMarketplace = invoice.transactionType === 'MARKETPLACE_PRODUCT';
    const sellerVendor = isMarketplace ? order.items?.find((it: any) => it.product?.vendor)?.product?.vendor : null;
    const recipient: PartyBlock = isMarketplace && sellerVendor
      ? { name: sellerVendor.businessName, address: sellerVendor.address, gstin: sellerVendor.gstNumber, state: sellerVendor.state }
      : customerBlock;
    return {
      isTaxInvoice: true,
      docBadge: 'TAX INVOICE',
      copyTag: isMarketplace ? 'ORIGINAL FOR SELLER — MARKETPLACE COMMISSION' : 'ORIGINAL FOR RECIPIENT — PLATFORM FEE',
      invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
      placeOfSupply: recipient.state || invoice.placeOfSupply || '',
      supplier: companyBlock,
      recipient,
      lines: lineSnapshot.remont || [],
      taxableValue: Number(invoice.platformCommission) + Number(invoice.bookingFee),
      cgst: Number(invoice.remontCgst), sgst: Number(invoice.remontSgst), igst: Number(invoice.remontIgst),
      discount: 0, roundOff: 0, total: Number(invoice.remontTotal), received: 0, bank,
      termsAndConditions: company.invoiceTerms, // Remont is always the supplier on this page
    };
  }

  // CUSTOMER page
  const isSummaryOnly = invoice.transactionType === 'PLATFORM_SERVICE';
  const isMarketplace = invoice.transactionType === 'MARKETPLACE_PRODUCT';
  const sellerVendor = isMarketplace ? order.items?.find((it: any) => it.product?.vendor)?.product?.vendor : null;
  const remontIsSupplier = !isMarketplace || !sellerVendor;
  const supplier: PartyBlock = isMarketplace && sellerVendor
    ? { name: sellerVendor.businessName, address: sellerVendor.address, gstin: sellerVendor.gstNumber, state: sellerVendor.state }
    : companyBlock;
  return {
    isTaxInvoice: !isSummaryOnly,
    isInformationalSummary: isSummaryOnly,
    docBadge: isSummaryOnly ? 'BOOKING SUMMARY — NOT A GST INVOICE' : 'TAX INVOICE',
    copyTag: 'ORIGINAL FOR RECIPIENT',
    invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.generatedAt,
    placeOfSupply: invoice.placeOfSupply || '',
    supplier,
    recipient: customerBlock,
    lines: lineSnapshot.customer || [],
    taxableValue: Number(invoice.customerSubtotal), cgst: Number(invoice.customerCgst), sgst: Number(invoice.customerSgst), igst: Number(invoice.customerIgst),
    discount: Number(invoice.discount), roundOff: Number(invoice.roundOff), total: Number(invoice.customerTotal),
    received: 0, bank: isSummaryOnly ? null : bank,
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
}

export async function renderInvoicePdf(
  invoice: any,
  docKind: InvoiceDocKind,
  ctx: { company: BillingCompanyConfig; order: any },
): Promise<Buffer> {
  const vm = buildInvoiceViewModel(invoice, docKind, ctx);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

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
    .text(`Invoice No.: ${vm.invoiceNumber}`, 46, y + 6)
    .text(`Invoice Date: ${vm.invoiceDate.toLocaleDateString('en-IN')}`, 40, y + 6, { width: pageWidth - 6, align: 'right' });
  y += 34;

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
    // Informational summary (e.g. the Type-1 booking summary) showing the real GST
    // charged on the Remont Platform Fee for transparency — this page is still not
    // itself the formal tax invoice for that GST (see the note below), so it's labeled
    // distinctly rather than presented as a CGST/SGST/IGST breakdown belonging to it.
    rightLine('GST on Remont Platform Fee', rupees(vm.igst > 0 ? vm.igst : vm.cgst + vm.sgst));
  } else {
    rightLine('GST', 'Not applicable');
  }
  if (vm.roundOff) rightLine('Round Off', rupees(vm.roundOff));
  rightLine('Total Amount', rupees(vm.total), true);
  rightLine('Received Amount', rupees(vm.received));
  rightLine('Balance Due', rupees(Math.max(0, vm.total - vm.received)));

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
  y += 30;

  if (vm.isInformationalSummary) {
    doc.fontSize(7).fillColor('#888')
      .text('This is a booking summary, not a GST tax invoice. The Partner Service Value is billed separately by the partner (GST as applicable to their own registration status); the GST shown above applies only to the Remont Platform Fee and is formally invoiced separately by Remont India Private Limited.', 40, y, { width: pageWidth });
    y += 26;
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

  doc.fontSize(8).fillColor('#111').text(`Authorised Signatory for ${vm.supplier.name}`, 40, y + 30, { width: pageWidth, align: 'right' });

  doc.end();
  return done;
}
