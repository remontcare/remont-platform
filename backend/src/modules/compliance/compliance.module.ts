import { Module, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { checkEInvoiceApplicability, checkEWayBillApplicability } from '../../common';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — e-Invoice (IRP) and e-Way Bill. Both are MOCK/sandbox adapters — no live
// government API credentials exist in this codebase (per the phase's own instruction:
// "use mock/sandbox API responses if real credentials are unavailable, NEVER use
// production credentials"). Only the adapter methods (mockIrpSubmit/mockEwbGenerate) would
// need replacing for a real integration; applicability logic, status handling and
// idempotency are unaffected either way.
//
// Deliberately NOT wired into the existing checkout/invoice-generation/shipment-delivery
// pipelines (MasterOrdersService.checkout(), InvoicesService.generateForOrder(),
// LogisticsService.onShipmentDelivered()) in this phase — those are the already-verified
// Phase 1–6 flows, and auto-triggering a new dependency inline risks regressing them. These
// services are standalone and callable on demand (an admin action or a scheduled job is the
// natural next wiring step, left for a follow-up so Phase 1–6 stay byte-for-byte unchanged).
// ═══════════════════════════════════════════════════════════════════════════

@Injectable()
export class EInvoiceService {
  private readonly logger = new Logger(EInvoiceService.name);
  constructor(private prisma: PrismaService) {}

  /**
   * Determines e-Invoice applicability and, if required, submits to the (mock) IRP.
   * Idempotent: an invoice already PENDING/SUBMITTED/SUCCESS is never resubmitted — avoids
   * ever registering the same invoice twice with the real IRP. Reads only the Invoice row's
   * own immutable Phase-4/5 snapshot plus the per-entity opt-in flag — never re-derives
   * anything from live Product/Seller/Company data.
   */
  async evaluateAndSubmit(invoiceId: string) {
    const existing = await this.prisma.eInvoiceRecord.findUnique({ where: { invoiceId } });
    if (existing && (existing.status === 'SUCCESS' || existing.status === 'SUBMITTED' || existing.status === 'PENDING')) {
      return existing;
    }

    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    // customerGstin only ever lives on MasterOrder (the whole-cart checkout) — a plain
    // single-Order booking (OrdersService.create()/GuestBookingService) never carries GST
    // details at all, so recipientGstin is null there — correctly resolved as B2C.
    const orderForGstin = await this.prisma.order.findUnique({
      where: { id: invoice.orderId },
      select: { masterOrder: { select: { customerGstin: true } } },
    });

    const issuerGstin = invoice.supplierGstin;
    const issuerEInvoicingEnabled = await this.resolveIssuerEInvoicingEnabled(invoice);
    const recipientGstin = orderForGstin?.masterOrder?.customerGstin || null;

    const { required, reason } = checkEInvoiceApplicability({ issuerGstin, issuerEInvoicingEnabled, recipientGstin });
    if (!required) {
      return this.prisma.eInvoiceRecord.upsert({
        where: { invoiceId },
        create: { invoiceId, status: 'NOT_REQUIRED', errorMessage: reason, environment: 'SANDBOX' },
        update: { status: 'NOT_REQUIRED', errorMessage: reason },
      });
    }

    // Workstream 4 — every submission this codebase can produce is SANDBOX (no real IRP
    // credentials exist); recorded explicitly so a report/viewer can never mistake a mock
    // IRN for a government-issued one.
    await this.prisma.eInvoiceRecord.upsert({
      where: { invoiceId },
      create: { invoiceId, status: 'PENDING', environment: 'SANDBOX' },
      update: { status: 'PENDING', errorCode: null, errorMessage: null },
    });
    try {
      const result = await this.mockIrpSubmit(invoice);
      return this.prisma.eInvoiceRecord.update({
        where: { invoiceId },
        data: {
          status: 'SUCCESS', irn: result.irn, ackNumber: result.ackNumber, ackDate: result.ackDate,
          signedInvoiceData: result.signedInvoiceData, qrPayload: result.qrPayload, submittedAt: new Date(),
        },
      });
    } catch (e: any) {
      // Never marked SUCCESS on a rejection — FAILED is distinct and retryable via a fresh
      // evaluateAndSubmit() call (the idempotency guard above only blocks re-submission of
      // an already-successful/in-flight registration, not a retry of a failed one).
      this.logger.error(`IRP submission failed for invoice ${invoiceId}: ${e.message}`);
      return this.prisma.eInvoiceRecord.update({
        where: { invoiceId },
        data: { status: 'FAILED', errorMessage: e.message, submittedAt: new Date() },
      });
    }
  }

  async cancel(invoiceId: string, reason: string) {
    const record = await this.prisma.eInvoiceRecord.findUnique({ where: { invoiceId } });
    if (!record || record.status !== 'SUCCESS') throw new BadRequestException('No successfully-registered e-Invoice to cancel');
    return this.prisma.eInvoiceRecord.update({
      where: { invoiceId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason },
    });
  }

  // MARKETPLACE_PRODUCT invoices are issued by the SELLER (per the confirmed business
  // model — see InvoicesService.generateForOrder()'s Type-3 branch) — so it's THAT seller's
  // own turnover/opt-in that matters, never Remont's. Every other transaction type is
  // Remont's own invoice, gated by a single SiteSetting (Remont has one GST registration).
  private async resolveIssuerEInvoicingEnabled(invoice: { transactionType: string | null; orderId: string }): Promise<boolean> {
    if (invoice.transactionType === 'MARKETPLACE_PRODUCT') {
      const order = await this.prisma.order.findUnique({
        where: { id: invoice.orderId },
        include: { items: { include: { product: { include: { vendor: { select: { eInvoiceEnabled: true } } } } } } },
      });
      const sellerVendor = order?.items.find((it) => it.product?.vendor)?.product?.vendor;
      return !!sellerVendor?.eInvoiceEnabled;
    }
    const setting = await this.prisma.siteSetting.findUnique({ where: { key: 'einvoice_enabled_remont' } });
    return setting?.value === 'true';
  }

  /** MOCK IRP adapter — replace this one method for a real integration; nothing else in
   * this service needs to change. */
  private async mockIrpSubmit(invoice: { id: string; invoiceNumber: string; customerTotal: any }): Promise<{ irn: string; ackNumber: string; ackDate: Date; signedInvoiceData: string; qrPayload: string }> {
    const irn = `MOCK-IRN-${invoice.id}-${Date.now()}`;
    return {
      irn,
      ackNumber: `MOCK-ACK-${Date.now()}`,
      ackDate: new Date(),
      signedInvoiceData: JSON.stringify({ invoiceNumber: invoice.invoiceNumber, total: Number(invoice.customerTotal) }),
      qrPayload: irn,
    };
  }
}

@Injectable()
export class EWayBillService {
  private readonly logger = new Logger(EWayBillService.name);
  constructor(private prisma: PrismaService) {}

  /** Statutory-figure fallback (₹50,000, the CGST base threshold) is used ONLY as the UI/
   * seed default when no admin override exists — never re-hardcoded into the applicability
   * check itself, which always reads this configured value. */
  async getThreshold(): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key: 'eway_bill_threshold_amount' } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : 50000;
  }

  async evaluate(orderId: string) {
    const existing = await this.prisma.eWayBillRecord.findUnique({ where: { orderId } });
    if (existing && (existing.status === 'GENERATED' || existing.status === 'PENDING')) return existing;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { type: true, gstAmount: true, productsTaxableAmount: true, productsAmount: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const consignmentValue = Number(order.productsTaxableAmount ?? order.productsAmount ?? 0) + Number(order.gstAmount || 0);
    const thresholdAmount = await this.getThreshold();
    const { required, reason } = checkEWayBillApplicability({ orderType: order.type, consignmentValue, thresholdAmount });

    if (!required) {
      return this.prisma.eWayBillRecord.upsert({
        where: { orderId },
        create: { orderId, status: 'NOT_REQUIRED', consignmentValue, errorMessage: reason, environment: 'SANDBOX' },
        update: { status: 'NOT_REQUIRED', consignmentValue, errorMessage: reason },
      });
    }

    // Workstream 4 — same SANDBOX-only reality as EInvoiceService above.
    await this.prisma.eWayBillRecord.upsert({
      where: { orderId },
      create: { orderId, status: 'PENDING', consignmentValue, environment: 'SANDBOX' },
      update: { status: 'PENDING', consignmentValue, errorCode: null, errorMessage: null },
    });
    try {
      const result = await this.mockEwbGenerate(orderId);
      return this.prisma.eWayBillRecord.update({
        where: { orderId },
        data: { status: 'GENERATED', ewbNumber: result.ewbNumber, ewbDate: result.ewbDate, validUntil: result.validUntil },
      });
    } catch (e: any) {
      this.logger.error(`EWB generation failed for order ${orderId}: ${e.message}`);
      return this.prisma.eWayBillRecord.update({
        where: { orderId },
        data: { status: 'FAILED', errorMessage: e.message },
      });
    }
  }

  async cancel(orderId: string, reason: string) {
    const record = await this.prisma.eWayBillRecord.findUnique({ where: { orderId } });
    if (!record || record.status !== 'GENERATED') throw new BadRequestException('No active e-Way Bill to cancel');
    return this.prisma.eWayBillRecord.update({
      where: { orderId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: reason },
    });
  }

  /** MOCK EWB adapter — replace this one method for a real integration. Validity window is
   * a simplistic placeholder (real EWB validity is distance-slab-based, e.g. 1 day per
   * 200km) — not modeled here, since this codebase's logistics data has no transport
   * distance field to derive it from (see the Phase 7 report). */
  private async mockEwbGenerate(orderId: string): Promise<{ ewbNumber: string; ewbDate: Date; validUntil: Date }> {
    const ewbDate = new Date();
    return { ewbNumber: `MOCK-EWB-${orderId}-${Date.now()}`, ewbDate, validUntil: new Date(ewbDate.getTime() + 24 * 60 * 60 * 1000) };
  }
}

@Module({ providers: [EInvoiceService, EWayBillService], exports: [EInvoiceService, EWayBillService] })
export class ComplianceModule {}
