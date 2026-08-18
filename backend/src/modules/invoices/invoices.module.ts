import { Module, Injectable, Controller, Get, Post, Param, UseGuards, NotFoundException, ForbiddenException, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import {
  JwtAuthGuard, CurrentUser, JwtPayload,
  buildInvoiceBreakdown, resolveBillingTransactionType, buildTaxRateResolver, getBillingCompanyConfig,
  stateFromGstin, PLATFORM_FEE_DEFAULT_RATE, PLATFORM_FEE_DEFAULT_SAC,
  type BillingLineInput, type BillingTransactionTypeValue,
} from '../../common';
import { renderInvoicePdf } from './invoice-pdf';

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
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const transactionType: BillingTransactionTypeValue =
      order.billingTransactionType || resolveBillingTransactionType(order.type, order.vendor?.staffType);
    const placeOfSupply = order.snapshotState || 'Madhya Pradesh';
    const company = await getBillingCompanyConfig(this.prisma);

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
      customerLines = [
        { description: order.service?.name || 'Partner Service Value', qty: 1, rate: partnerAmount, taxRatePercent: 0 },
        ...(feeAmount > 0 ? [{ description: 'Remont Platform Fee', qty: 1, rate: feeAmount, taxRatePercent: feeRate }] : []),
        ...(bookingFee > 0 ? [{ description: 'Booking Fee', qty: 1, rate: bookingFee, taxRatePercent: feeRate }] : []),
      ];
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
        taxRatePercent: prodTax.rateFor(it.product.hsnSac, it.product.gstOverridePercent),
      }));
      if (sellerVendor) {
        // The seller's GSTIN state prefix is authoritative when present — more reliable
        // than the free-text `state` field, which only matters as a fallback for a
        // seller who hasn't provided a GSTIN at all.
        customerSupplierState = stateFromGstin(sellerVendor.gstNumber) || sellerVendor.state || null;
        customerSupplierGstin = sellerVendor.gstNumber || null;
      }

      const commission = Number(order.remontCommission);
      if (sellerVendor && commission > 0) {
        const sellerState = stateFromGstin(sellerVendor.gstNumber) || sellerVendor.state || placeOfSupply;
        remontLines = [{ description: 'Marketplace Commission', hsnSac: feeTax.defaultHsn || PLATFORM_FEE_DEFAULT_SAC, qty: 1, rate: commission, taxRatePercent: feeTax.rateFor(null, null) }];
        remontPlaceOfSupply = sellerState;
      }
    }

    const count = await this.prisma.invoice.count();
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
    }, count);

    const invoice = await this.prisma.invoice.create({ data: { orderId, ...breakdown } });
    if (!order.billingTransactionType) {
      await this.prisma.order.update({ where: { id: orderId }, data: { billingTransactionType: transactionType } });
    }
    return invoice;
  }

  async generate(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { vendor: true },
    });
    if (!order) throw new NotFoundException();
    // Previously ungated — any authenticated user could generate (and thereby read, since
    // the created row is returned directly) another customer's invoice by orderId alone.
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    return this.generateForOrder(orderId);
  }

  async get(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { invoice: true, vendor: true },
    });
    if (!order?.invoice) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    return order.invoice;
  }

  async getPdfBuffer(userId: string, orderId: string, docKind: 'CUSTOMER' | 'VENDOR' | 'REMONT') {
    const order = await this.fetchOrderForPdf(orderId);
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
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
  @Get('orders/:orderId/pdf')
  async pdf(@CurrentUser() u: JwtPayload, @Param('orderId') id: string, @Res() res: Response) {
    const buf = await this.inv.getPdfBuffer(u.sub, id, 'CUSTOMER');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${id}.pdf"`);
    res.send(buf);
  }
}

@Module({ controllers: [InvoicesController], providers: [InvoicesService], exports: [InvoicesService] })
export class InvoicesModule {}
