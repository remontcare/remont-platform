import { Module, Injectable, Controller, Get, Post, Param, Query, UseGuards, NotFoundException, ForbiddenException, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import {
  JwtAuthGuard, CurrentUser, JwtPayload,
  buildInvoiceBreakdown, resolveBillingTransactionType, buildTaxRateResolver, getBillingCompanyConfig,
  stateFromGstin, PLATFORM_FEE_DEFAULT_RATE, PLATFORM_FEE_DEFAULT_SAC, distributeInvoiceDiscount,
  nextInvoiceDocumentNumber,
  type BillingLineInput, type BillingTransactionTypeValue,
} from '../../common';
import { renderInvoicePdf, buildInvoiceViewModel, type InvoiceDocKind } from './invoice-pdf';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  /**
   * The single entry point for turning an Order into an Invoice row — every caller
   * (customer-facing generate endpoint, OrdersService.autoGenerateInvoice on completion,
   * AdminService's auto + manual "Generate Invoice" paths) goes through this one method.
   * Replaces four call sites that used to each carry their own copy of the GST math (one
   * of which, the admin manual-generate endpoint, didn't even share code with the other
   * three) — see backend/src/common/billing-engine.ts for the actual calculation engine.
   */
  async generateForOrder(orderId: string) {
    const existing = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (existing) return existing;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        vendor: true,
        service: true,
        serviceItems: { include: { service: true } },
        items: { include: { product: { include: { vendor: true } } } },
        extraWorkItems: { where: { customerApproved: true } },
        discountAllocation: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const transactionType: BillingTransactionTypeValue =
      order.billingTransactionType || resolveBillingTransactionType(order.type, order.vendor?.staffType);
    const placeOfSupply = order.snapshotState || 'Madhya Pradesh';
    const company = await getBillingCompanyConfig(this.prisma);

    // Phase 3 (M-04) — the order's real customer-facing discount, always shown on the
    // invoice from here on (was hardcoded to 0 before — see the Phase 3 report). Whether
    // it's allowed to reduce THIS invoice's taxable value follows exactly what checkout
    // already decided for the PRODUCT case (OrderDiscountAllocation.taxableValueReduced —
    // a SELLER-funded PRODUCT order had its GST already computed on the discounted amount,
    // a PLATFORM-funded one deliberately never does, an open CA question). A SERVICE
    // order's taxable value is always already discounted at checkout regardless (pre-
    // existing, unconditional) — set per-branch below, not read from the allocation flag.
    const orderDiscount = Math.round(((Number(order.couponDiscount || 0) + Number(order.membershipDiscount || 0)) + Number.EPSILON) * 100) / 100;
    // Orders predating this feature have no allocation row — fallback reproduces exactly
    // what their checkout actually did (every PRODUCT order left taxable value untouched).
    const productDiscountReducesTaxableValue = order.discountAllocation ? order.discountAllocation.taxableValueReduced : false;
    let discountReducesTaxableValue = false;

    let customerLines: BillingLineInput[] = [];
    let customerSupplierState: string | null = company.state;
    let customerSupplierGstin: string | null = company.gstin;
    let vendorLines: BillingLineInput[] = [];
    let remontLines: BillingLineInput[] = [];
    let remontPlaceOfSupply = placeOfSupply;
    let bookingFee = 0;

    if (transactionType === 'DIRECT_PROJECT') {
      // Type 2 — Remont's own team fulfils the work. Full project value, one tax invoice.
      // Each line resolves its OWN GST rate by its own HSN/SAC — different services
      // legitimately sit in different GST slabs, so this is never a single blanket rate.
      const svcTax = await buildTaxRateResolver(this.prisma, 'SERVICE');
      customerLines = order.serviceItems.map((si) => ({
        description: si.service.name,
        hsnSac: si.service.hsnSac || svcTax.defaultHsn,
        qty: si.quantity,
        unit: si.service.unit,
        rate: Number(si.unitPrice),
        taxRatePercent: svcTax.rateFor(si.service.hsnSac, si.service.gstOverridePercent),
      }));
      for (const ew of order.extraWorkItems) {
        customerLines.push({ description: ew.description, qty: 1, rate: Number(ew.amount), taxRatePercent: svcTax.rateFor(order.service?.hsnSac, order.service?.gstOverridePercent) });
      }
      // Phase 3 (M-04) — checkout already computed this order's GST on the discounted
      // amount (unconditional for every SERVICE order); mirror that here so the invoice's
      // taxable value/GST/total agree with what checkout actually charged, instead of
      // silently pricing every line at full rate while `discount` sat hardcoded at 0.
      customerLines = distributeInvoiceDiscount(customerLines, orderDiscount);
      discountReducesTaxableValue = true;
    } else if (transactionType === 'PLATFORM_SERVICE') {
      // Type 1 — a partner fulfils the job. TWO separate legal billing documents are
      // always kept apart, never merged into one Remont invoice:
      //   (1) Partner Service Invoice (vendorLines below) — issued in the partner's own
      //       name for the partner's share; GST only if the partner is itself
      //       GST-registered (never assumed/fabricated for an unregistered partner).
      //   (2) Remont Platform Fee Invoice (remontLines below) — issued by Remont India
      //       Private Limited for Remont's fee alone, taxed under its own SAC (business
      //       auxiliary service), never the underlying service's SAC.
      // The customer page is a third, informational summary only (never itself a formal
      // tax invoice — no supplierGstin, so it's never mistaken for one) that shows both
      // amounts PLUS the GST on the platform fee for transparency, reusing the exact
      // same rate/place-of-supply the formal Remont Platform Fee Invoice uses, so the
      // numbers always agree — never a second, independently-derived GST figure.
      const svcTax = await buildTaxRateResolver(this.prisma, 'SERVICE');
      const feeTax = await buildTaxRateResolver(this.prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
      const partnerAmount = Number(order.serviceAmount) + order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
      const feeAmount = Number(order.remontCommission) + Number(order.platformCharges);
      const feeRate = feeTax.rateFor(null, null);
      const feeSetting = await this.prisma.siteSetting.findUnique({ where: { key: 'default_booking_fee' } });
      bookingFee = feeSetting ? parseFloat(feeSetting.value) || 0 : 49;

      // Customer summary mirrors exactly what the formal Remont Platform Fee Invoice
      // below will bill (fee + booking fee, both at feeRate) so the GST-on-fee figure
      // shown here is never a second, independently-derived number — it's the identical
      // calculateInvoice() math, just also surfaced on this informational page.
      // Phase 3 (M-04) — the partner-value line is the only one a customer discount ever
      // applied to at checkout (the platform fee/booking fee below are Remont's own take,
      // untouched by a customer coupon) — reduce only that line, not the whole array,
      // same "checkout already discounted this" reasoning as the DIRECT_PROJECT branch.
      const [partnerLine] = distributeInvoiceDiscount(
        [{ description: order.service?.name || 'Partner Service Value', qty: 1, rate: partnerAmount, taxRatePercent: 0 }],
        orderDiscount,
      );
      customerLines = [
        partnerLine,
        ...(feeAmount > 0 ? [{ description: 'Remont Platform Fee', qty: 1, rate: feeAmount, taxRatePercent: feeRate }] : []),
        ...(bookingFee > 0 ? [{ description: 'Booking Fee', qty: 1, rate: bookingFee, taxRatePercent: feeRate }] : []),
      ];
      discountReducesTaxableValue = true;
      // Set so the engine computes the correct GST-on-fee figure for display above — this
      // does NOT make the summary a tax invoice (invoice-pdf.ts forces the "not a GST
      // invoice" badge for this page regardless); supplierGstin stays blank so it's never
      // printed as if it carried Remont's GSTIN as an invoicing entity.
      customerSupplierState = company.state;
      customerSupplierGstin = null;

      vendorLines = partnerAmount > 0
        ? [{ description: order.service?.name || 'Partner Service Value', hsnSac: order.service?.hsnSac || svcTax.defaultHsn, qty: 1, rate: partnerAmount, taxRatePercent: svcTax.rateFor(order.service?.hsnSac, order.service?.gstOverridePercent) }]
        : [];

      if (feeAmount > 0) {
        remontLines = [{ description: 'Remont Platform Fee', hsnSac: feeTax.defaultHsn || PLATFORM_FEE_DEFAULT_SAC, qty: 1, rate: feeAmount, taxRatePercent: feeRate }];
      }
    } else {
      // Type 3 — marketplace product sale. The seller is the invoicing entity for the
      // product line items (per confirmed decision); admin-owned catalog items with no
      // seller vendor fall back to Remont as supplier, since there's no one else to
      // invoice as. Remont's own commission (if any) goes to the seller separately,
      // as a distinct invoice whose recipient is the seller, not the customer, taxed
      // under the platform-fee SAC like any other Remont commission.
      const prodTax = await buildTaxRateResolver(this.prisma, 'PRODUCT');
      const feeTax = await buildTaxRateResolver(this.prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
      const sellerVendor = order.items.find((it) => it.product.vendor)?.product.vendor || null;
      customerLines = order.items.map((it) => ({
        description: it.product.name,
        hsnSac: it.product.hsnSac || prodTax.defaultHsn,
        qty: it.quantity,
        unit: it.product.unit,
        rate: Number(it.unitPrice),
        // C-04 — read the GST rate/price-type actually frozen on this OrderItem at
        // checkout (resolveProductGstLine(), Phase 8) instead of re-resolving it from the
        // Product's CURRENT hsnSac/gstOverridePercent/gstInclusive. Re-deriving live meant
        // an admin editing a product's tax config after the order was placed silently
        // changed a past, possibly-already-issued invoice's numbers — and, independent of
        // any later edit, an already-GST-inclusive item was always mis-priced-type'd as
        // EXCLUSIVE here (priceType was never even set), so GST was added a second time on
        // top of a price that already included it. `it.gstRatePercent`/`it.gstInclusive`
        // are null only for a legacy line created before this snapshot existed — those
        // fall back to today's live-resolution, unchanged.
        taxRatePercent: it.gstRatePercent != null ? Number(it.gstRatePercent) : prodTax.rateFor(it.product.hsnSac, it.product.gstOverridePercent),
        priceType: (it.gstRatePercent != null ? it.gstInclusive : prodTax.priceTypeFor(it.product.hsnSac, it.product.categoryId, it.product.gstInclusive) === 'INCLUSIVE') ? 'INCLUSIVE' as const : 'EXCLUSIVE' as const,
      }));
      if (sellerVendor) {
        // The seller's GSTIN state prefix is authoritative when present — more reliable
        // than the free-text `state` field, which only matters as a fallback for a
        // seller who hasn't provided a GSTIN at all.
        customerSupplierState = stateFromGstin(sellerVendor.gstNumber) || sellerVendor.state || null;
        customerSupplierGstin = sellerVendor.gstNumber || null;
      }
      // Phase 3 (C-02/M-04) — only a SELLER-funded coupon's discount reduces this invoice's
      // taxable value (mirrors what checkout's applySellerFundedDiscountToProductGst()
      // already did to order.productsTaxableAmount — see OrderDiscountAllocation). A
      // PLATFORM-funded discount (the default) leaves every line exactly at full rate —
      // whether it should legally reduce a seller's taxable value is an open CA question,
      // never guessed here — and is instead netted off customerTotal post-tax below
      // (buildInvoiceBreakdown's discount/discountReducesTaxableValue=false path).
      if (productDiscountReducesTaxableValue) {
        customerLines = distributeInvoiceDiscount(customerLines, orderDiscount);
      }
      discountReducesTaxableValue = productDiscountReducesTaxableValue;

      const commission = Number(order.remontCommission);
      if (sellerVendor && commission > 0) {
        const sellerState = stateFromGstin(sellerVendor.gstNumber) || sellerVendor.state || placeOfSupply;
        remontLines = [{ description: 'Marketplace Commission', hsnSac: feeTax.defaultHsn || PLATFORM_FEE_DEFAULT_SAC, qty: 1, rate: commission, taxRatePercent: feeTax.rateFor(null, null) }];
        remontPlaceOfSupply = sellerState;
      }
    }

    const breakdown = buildInvoiceBreakdown({
      orderNumber: order.orderNumber,
      transactionType,
      placeOfSupply,
      remontState: company.state,
      remontGstin: company.gstin,
      bookingFee,
      customerLines,
      customerSupplierState,
      customerSupplierGstin,
      vendorLines,
      vendorGstin: order.vendor?.gstin,
      remontLines,
      remontPlaceOfSupply,
      discount: orderDiscount,
      discountReducesTaxableValue,
    });

    // C-05 — freeze this invoice's party identity (supplier/recipient name, address,
    // GSTIN, state) exactly once, right now, at generation time — the one moment `order`/
    // `company` are legitimately live. Reuses buildInvoiceViewModel() itself (the same
    // function invoice-pdf.ts renders from) rather than re-deriving the party logic a
    // second time, so the two can never drift. Every later render (invoice-pdf.ts) prefers
    // this frozen block over re-reading the seller's/customer's/Remont's CURRENT master
    // data, so an issued invoice's legal party details can never silently change after the
    // fact just because someone edits a profile/business listing later.
    const partySnapshotSource = { ...breakdown, generatedAt: new Date() };
    const parties: Record<string, { supplier: unknown; recipient: unknown }> = {};
    for (const [key, docKind] of [['customer', 'CUSTOMER'], ['vendor', 'VENDOR'], ['remont', 'REMONT']] as [string, InvoiceDocKind][]) {
      const vm = buildInvoiceViewModel(partySnapshotSource, docKind, { company, order });
      parties[key] = { supplier: vm.supplier, recipient: vm.recipient };
    }
    (breakdown as any).lineItemsSnapshot = { ...(breakdown.lineItemsSnapshot as any), parties };

    // Phase 5 (C-07/C-08/L-01) — BEGIN TRANSACTION -> atomic per-series counter -> CREATE
    // -> COMMIT, all in one DB transaction: if invoice.create() fails, the counter
    // increment(s) above roll back with it, so a failed generation never burns/reuses a
    // number. CUSTOMER's number is always allocated (every transaction type has a
    // customer-facing page); VENDOR/REMONT are legally distinct documents (different
    // issuer/recipient — C-08) and only get their own number when that page actually
    // exists for this order, so an order with no partner line or no Remont commission
    // never wastes a sequence slot on a document that was never issued.
    const invoice = await this.prisma.$transaction(async (tx) => {
      const customerDocumentNumber = await nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE');
      const vendorDocumentNumber = vendorLines.length ? await nextInvoiceDocumentNumber(tx, 'PARTNER_SETTLEMENT_INVOICE') : null;
      const remontDocumentNumber = remontLines.length ? await nextInvoiceDocumentNumber(tx, 'PLATFORM_FEE_INVOICE') : null;
      return tx.invoice.create({
        data: { orderId, ...breakdown, invoiceNumber: customerDocumentNumber, vendorDocumentNumber, remontDocumentNumber },
      });
    });
    if (!order.billingTransactionType) {
      await this.prisma.order.update({ where: { id: orderId }, data: { billingTransactionType: transactionType } });
    }
    return invoice;
  }

  /**
   * Phase 6 (C-06) — the formal GST correction document for a refund that happens AFTER an
   * Invoice was already issued for this order. Called by RefundsService.decide() right after
   * money actually moves. Never touches the original Invoice row (immutable — Phase 4);
   * reuses its already-computed customerSubtotal/cgst/sgst/igst, scaled by the refund's
   * share of the invoice total, rather than re-deriving GST. A no-op (returns null) when no
   * Invoice exists for this order at all — there's nothing to formally correct, and this
   * phase does not invent invoicing for orders that were never invoiced.
   */
  async issueCreditNote(orderId: string, refundRequestId: string | undefined, refundAmount: number, reason: string) {
    if (refundAmount <= 0) return null;
    const invoice = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (!invoice) return null;
    const invoiceTotal = Number(invoice.customerTotal);
    if (invoiceTotal <= 0) return null;

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const ratio = Math.min(1, refundAmount / invoiceTotal);
    const taxableValueReversed = round2(Number(invoice.customerSubtotal) * ratio);
    const cgstReversed = round2(Number(invoice.customerCgst) * ratio);
    const sgstReversed = round2(Number(invoice.customerSgst) * ratio);
    const igstReversed = round2(Number(invoice.customerIgst) * ratio);
    const totalReversed = round2(Math.min(refundAmount, invoiceTotal));

    return this.prisma.$transaction(async (tx) => {
      const creditNoteNumber = await nextInvoiceDocumentNumber(tx, 'CREDIT_NOTE');
      return tx.creditNote.create({
        data: {
          creditNoteNumber, invoiceId: invoice.id, orderId, refundRequestId, reason,
          taxableValueReversed, cgstReversed, sgstReversed, igstReversed, totalReversed,
        },
      });
    });
  }

  // order.vendor is the ServiceVendor FK (order.vendorId) — always null for a PRODUCT order,
  // so it alone can never authorize that order's own product seller. A product order's
  // invoicing entity is instead whichever ProductVendor owns its line items (see Type 3
  // branch in generateForOrder() above), so that seller must also be allowed through.
  private isAuthorizedForInvoice(userId: string, order: { customerId: string; vendor?: { userId: string } | null; items?: { product?: { vendor?: { userId: string } | null } | null }[] }): boolean {
    if (order.customerId === userId) return true;
    if (order.vendor?.userId === userId) return true;
    return !!order.items?.some((it) => it.product?.vendor?.userId === userId);
  }

  async generate(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { vendor: true, items: { include: { product: { include: { vendor: true } } } } },
    });
    if (!order) throw new NotFoundException();
    // Previously ungated — any authenticated user could generate (and thereby read, since
    // the created row is returned directly) another customer's invoice by orderId alone.
    if (!this.isAuthorizedForInvoice(userId, order)) throw new ForbiddenException();
    return this.generateForOrder(orderId);
  }

  async get(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { invoice: true, vendor: true, items: { include: { product: { include: { vendor: true } } } } },
    });
    if (!order?.invoice) throw new NotFoundException();
    if (!this.isAuthorizedForInvoice(userId, order)) throw new ForbiddenException();
    return order.invoice;
  }

  async getPdfBuffer(userId: string, orderId: string, docKind: 'CUSTOMER' | 'VENDOR' | 'REMONT') {
    const order = await this.fetchOrderForPdf(orderId);
    if (!this.isAuthorizedForInvoice(userId, order)) throw new ForbiddenException();
    // Phase 8 (H-08/Workstream 5) — isAuthorizedForInvoice() is deliberately "any party to
    // this order" for every docKind, which was harmless while the controller only ever
    // requested 'CUSTOMER'. Now that docKind is caller-selectable, a MARKETPLACE_PRODUCT
    // order's REMONT page (Remont's commission invoice TO THE SELLER — see invoice-pdf.ts's
    // recipient logic) must stay seller/admin-only: it is not addressed to the customer,
    // who is otherwise authorized on this order for the pages that ARE addressed to them.
    if (docKind === 'REMONT' && order.invoice?.transactionType === 'MARKETPLACE_PRODUCT') {
      const isSeller = !!order.items?.some((it: any) => it.product?.vendor?.userId === userId);
      if (!isSeller) throw new ForbiddenException();
    }
    return this.renderPdfForOrder(order, docKind);
  }

  /** Unrestricted variant for the admin panel — AdminController already gates by role. */
  async getPdfBufferAdmin(orderId: string, docKind: 'CUSTOMER' | 'VENDOR' | 'REMONT') {
    const order = await this.fetchOrderForPdf(orderId);
    return this.renderPdfForOrder(order, docKind);
  }

  private async fetchOrderForPdf(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        invoice: true, vendor: true, customer: true, address: true, masterOrder: true,
        service: { include: { category: { select: { warrantyDays: true } } } },
        items: { include: { product: { include: { vendor: true } } } },
      },
    });
    if (!order?.invoice) throw new NotFoundException();
    return order;
  }

  private async renderPdfForOrder(order: any, docKind: 'CUSTOMER' | 'VENDOR' | 'REMONT') {
    const company = await getBillingCompanyConfig(this.prisma);
    return renderInvoicePdf(order.invoice, docKind, { company, order });
  }
}

@ApiTags('Invoices')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private inv: InvoicesService) {}
  @Post('orders/:orderId/generate') gen(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) { return this.inv.generate(u.sub, id); }
  @Get('orders/:orderId') get(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) {
    return this.inv.get(u.sub, id);
  }
  // Phase 8 (H-08) — getPdfBuffer() already accepts/authorizes any of the 3 docKinds (the
  // SAME isAuthorizedForInvoice() check regardless of which page is requested — a seller is
  // already allowed through for their own order, a partner for theirs), but this route used
  // to hardcode 'CUSTOMER', so a seller/partner had no way to ever reach their OWN
  // commission/settlement-invoice page for an order they're legitimately part of. Defaults
  // to 'CUSTOMER' — every existing caller/URL is byte-for-byte unchanged.
  @Get('orders/:orderId/pdf')
  async pdf(@CurrentUser() u: JwtPayload, @Param('orderId') id: string, @Query('docKind') docKind: string | undefined, @Res() res: Response) {
    const kind = docKind === 'VENDOR' || docKind === 'REMONT' ? docKind : 'CUSTOMER';
    const buf = await this.inv.getPdfBuffer(u.sub, id, kind);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${id}-${kind.toLowerCase()}.pdf"`);
    res.send(buf);
  }
}

@Module({ controllers: [InvoicesController], providers: [InvoicesService], exports: [InvoicesService] })
export class InvoicesModule {}
