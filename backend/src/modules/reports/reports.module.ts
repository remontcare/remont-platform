import { Module, Injectable, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import Excel from 'exceljs';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common';
import { UserRole } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════════════════
// GST / Accounting / Ledger Excel exports — every row is read from already-
// stored Invoice/PaymentTransaction/PartnerLedgerEntry data (no report-time GST
// recalculation; the billing engine already computed and froze these numbers
// at invoice-generation time). Full transaction-level detail, never
// pre-aggregated, per §9 of the billing spec.
// ═══════════════════════════════════════════════════════════════════════════

interface DateRange { from?: Date; to?: Date }

function parseRange(from?: string, to?: string): DateRange {
  return {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(new Date(to).getTime() + 86_400_000 - 1) : undefined, // inclusive end-of-day
  };
}

function dateFilter(range: DateRange) {
  if (!range.from && !range.to) return undefined;
  return { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) };
}

async function toBuffer(wb: Excel.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function sendXlsx(res: Response, buf: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  // ─── GST report — one row per invoice "page" that actually carries a GST/total
  // value: the customer page (always, if it's a real tax invoice — not a Type-1
  // informational summary), the Remont page (platform fee / marketplace commission),
  // and the vendor/partner settlement page (only when the partner is GST-registered).
  async gstReportRows(range: DateRange) {
    const invoices = await this.prisma.invoice.findMany({
      where: { generatedAt: dateFilter(range) },
      include: {
        order: {
          include: {
            customer: { select: { name: true } },
            vendor: { select: { fullName: true, businessName: true, gstin: true } },
          },
        },
      },
      orderBy: { generatedAt: 'asc' },
    });

    const rows: any[] = [];
    for (const inv of invoices) {
      const isSummaryOnly = inv.transactionType === 'PLATFORM_SERVICE';
      if (!isSummaryOnly) {
        rows.push({
          invoiceNo: inv.invoiceNumber, invoiceDate: inv.generatedAt, transactionType: inv.transactionType || 'UNCLASSIFIED',
          partyName: inv.order?.customer?.name || inv.order?.guestName || 'Customer',
          gstin: inv.supplierGstin || '', placeOfSupply: inv.placeOfSupply || '',
          taxableValue: Number(inv.customerSubtotal), cgst: Number(inv.customerCgst), sgst: Number(inv.customerSgst), igst: Number(inv.customerIgst),
          totalValue: Number(inv.customerTotal),
        });
      }
      if (Number(inv.remontTotal) > 0) {
        rows.push({
          invoiceNo: inv.invoiceNumber + '-FEE', invoiceDate: inv.generatedAt, transactionType: `${inv.transactionType || 'UNCLASSIFIED'} (Remont Fee)`,
          partyName: inv.order?.customer?.name || 'Customer',
          gstin: '', placeOfSupply: inv.placeOfSupply || '',
          taxableValue: Number(inv.platformCommission) + Number(inv.bookingFee), cgst: Number(inv.remontCgst), sgst: Number(inv.remontSgst), igst: Number(inv.remontIgst),
          totalValue: Number(inv.remontTotal),
        });
      }
      if (Number(inv.vendorTotal) > 0 && inv.order?.vendor?.gstin) {
        rows.push({
          invoiceNo: inv.invoiceNumber + '-PTR', invoiceDate: inv.generatedAt, transactionType: `${inv.transactionType || 'UNCLASSIFIED'} (Partner Settlement)`,
          partyName: inv.order?.vendor?.fullName || inv.order?.vendor?.businessName || 'Partner',
          gstin: inv.order?.vendor?.gstin || '', placeOfSupply: inv.placeOfSupply || '',
          taxableValue: Number(inv.vendorLabor), cgst: Number(inv.vendorCgst), sgst: Number(inv.vendorSgst), igst: 0,
          totalValue: Number(inv.vendorTotal),
        });
      }
    }
    return rows;
  }

  async generateGstReport(range: DateRange): Promise<Buffer> {
    const rows = await this.gstReportRows(range);
    const wb = new Excel.Workbook();
    const ws = wb.addWorksheet('GST Report');
    ws.columns = [
      { header: 'Invoice No.', key: 'invoiceNo', width: 20 },
      { header: 'Invoice Date', key: 'invoiceDate', width: 14 },
      { header: 'Transaction Type', key: 'transactionType', width: 30 },
      { header: 'Party Name', key: 'partyName', width: 22 },
      { header: 'GSTIN', key: 'gstin', width: 18 },
      { header: 'Place of Supply', key: 'placeOfSupply', width: 18 },
      { header: 'Taxable Value', key: 'taxableValue', width: 16 },
      { header: 'CGST', key: 'cgst', width: 12 },
      { header: 'SGST', key: 'sgst', width: 12 },
      { header: 'IGST', key: 'igst', width: 12 },
      { header: 'Total Invoice Value', key: 'totalValue', width: 18 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow({ ...r, invoiceDate: r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString('en-IN') : '' });
    return toBuffer(wb);
  }

  // ─── Accounting report — one row per Order, with Platform/Direct/Product income
  // kept in three separate columns so they're never blended into one revenue figure.
  async generateAccountingReport(range: DateRange): Promise<Buffer> {
    // PaymentTransaction links to Order loosely by orderId (not a declared Prisma
    // relation), so payments are fetched separately and joined in memory below.
    const ordersList = await this.prisma.order.findMany({
      where: { createdAt: dateFilter(range) },
      include: { invoice: true },
      orderBy: { createdAt: 'asc' },
    });
    const orderIds = ordersList.map((o) => o.id);
    const payments = orderIds.length
      ? await this.prisma.paymentTransaction.findMany({ where: { orderId: { in: orderIds } } })
      : [];
    const paymentsByOrder = new Map<string, typeof payments>();
    for (const p of payments) {
      if (!p.orderId) continue;
      if (!paymentsByOrder.has(p.orderId)) paymentsByOrder.set(p.orderId, []);
      paymentsByOrder.get(p.orderId)!.push(p);
    }

    const wb = new Excel.Workbook();
    const ws = wb.addWorksheet('Accounting Report');
    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Transaction Type', key: 'type', width: 20 },
      { header: 'Order Reference', key: 'orderRef', width: 18 },
      { header: 'Invoice Reference', key: 'invoiceRef', width: 20 },
      { header: 'Gross Sales', key: 'gross', width: 14 },
      { header: 'Discounts', key: 'discount', width: 12 },
      { header: 'Taxable Value', key: 'taxable', width: 14 },
      { header: 'GST Collected', key: 'gst', width: 14 },
      { header: 'Platform Commission Income', key: 'platformIncome', width: 24 },
      { header: 'Direct Service Income', key: 'directIncome', width: 20 },
      { header: 'Product Sales Income', key: 'productIncome', width: 20 },
      { header: 'Payment Received', key: 'paymentReceived', width: 16 },
      { header: 'Refunds', key: 'refunds', width: 12 },
      { header: 'Net Transaction Value', key: 'net', width: 18 },
      { header: 'Transaction Status', key: 'status', width: 16 },
      { header: 'Payment Mode', key: 'paymentMode', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const o of ordersList) {
      const type = o.billingTransactionType || o.invoice?.transactionType || 'UNCLASSIFIED';
      const paid = (paymentsByOrder.get(o.id) || []).filter((p) => p.status === 'PAID').reduce((s, p) => s + Number(p.amount), 0);
      const refunded = (paymentsByOrder.get(o.id) || []).filter((p) => p.refundRequestId).reduce((s, p) => s + Number(p.amount), 0);
      const remontRevenue = type === 'DIRECT_PROJECT' ? Number(o.subtotal) : Number(o.remontCommission) + Number(o.platformCharges);
      ws.addRow({
        date: o.createdAt.toLocaleDateString('en-IN'),
        type,
        orderRef: o.orderNumber,
        invoiceRef: o.invoice?.invoiceNumber || '',
        gross: Number(o.subtotal),
        discount: Number(o.couponDiscount) + Number(o.membershipDiscount),
        taxable: o.invoice ? Number(o.invoice.customerSubtotal) : Number(o.subtotal),
        gst: o.invoice ? Number(o.invoice.customerCgst) + Number(o.invoice.customerSgst) + Number(o.invoice.customerIgst) : 0,
        platformIncome: type === 'PLATFORM_SERVICE' ? remontRevenue : 0,
        directIncome: type === 'DIRECT_PROJECT' ? remontRevenue : 0,
        productIncome: type === 'MARKETPLACE_PRODUCT' ? remontRevenue : 0,
        paymentReceived: paid,
        refunds: refunded,
        net: paid - refunded,
        status: o.status,
        paymentMode: o.paymentMethod || '',
      });
    }
    return toBuffer(wb);
  }

  // ─── Ledger report — party-wise running balance. Customers from PaymentTransaction,
  // partners from the existing PartnerLedgerEntry (which already maintains its own
  // running balanceAfter), sellers derived from their product-order invoices (no
  // dedicated seller ledger table exists yet, so this computes a simple net-payable
  // running total in-report rather than introducing a new persisted table).
  async generateLedgerReport(range: DateRange, partyType?: 'CUSTOMER' | 'PARTNER' | 'SELLER'): Promise<Buffer> {
    const wb = new Excel.Workbook();
    const ws = wb.addWorksheet('Ledger Report');
    ws.columns = [
      { header: 'Party Type', key: 'partyType', width: 12 },
      { header: 'Party Name', key: 'partyName', width: 22 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Reference', key: 'ref', width: 20 },
      { header: 'Debit', key: 'debit', width: 12 },
      { header: 'Credit', key: 'credit', width: 12 },
      { header: 'Running Balance', key: 'balance', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };

    if (!partyType || partyType === 'CUSTOMER') {
      // PaymentTransaction.userId is a plain scalar, not a declared Prisma relation (see
      // its schema comment — linked loosely, not FK-enforced), so names are joined in
      // memory rather than via `include`.
      const payments = await this.prisma.paymentTransaction.findMany({
        where: { createdAt: dateFilter(range), isWalletTopup: false },
        orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
      });
      const userIds = [...new Set(payments.map((p) => p.userId))];
      const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
      const namesById = new Map(users.map((u) => [u.id, u.name]));
      const balances = new Map<string, number>();
      for (const p of payments) {
        const isRefund = !!p.refundRequestId;
        const prev = balances.get(p.userId) || 0;
        const delta = isRefund ? -Number(p.amount) : Number(p.amount);
        const next = prev + delta;
        balances.set(p.userId, next);
        ws.addRow({
          partyType: 'CUSTOMER', partyName: namesById.get(p.userId) || p.userId,
          date: p.createdAt.toLocaleDateString('en-IN'), ref: p.gatewayPaymentId || p.id,
          debit: isRefund ? Number(p.amount) : 0, credit: isRefund ? 0 : Number(p.amount),
          balance: next,
        });
      }
    }

    if (!partyType || partyType === 'PARTNER') {
      const entries = await this.prisma.partnerLedgerEntry.findMany({
        where: { createdAt: dateFilter(range) },
        include: { vendor: { select: { fullName: true, businessName: true } } },
        orderBy: [{ vendorId: 'asc' }, { createdAt: 'asc' }],
      });
      for (const e of entries) {
        const amt = Number(e.amount);
        ws.addRow({
          partyType: 'PARTNER', partyName: e.vendor?.fullName || e.vendor?.businessName || e.vendorId,
          date: e.createdAt.toLocaleDateString('en-IN'), ref: e.type + (e.orderId ? ` — ${e.orderId.slice(-8)}` : ''),
          debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0,
          balance: Number(e.balanceAfter),
        });
      }
    }

    if (!partyType || partyType === 'SELLER') {
      const orders = await this.prisma.order.findMany({
        where: { type: 'PRODUCT', createdAt: dateFilter(range) },
        include: {
          invoice: true,
          items: { include: { product: { include: { vendor: { select: { id: true, businessName: true } } } } } },
        },
        orderBy: { createdAt: 'asc' },
      });
      const balances = new Map<string, number>();
      for (const o of orders) {
        const seller = o.items.find((it) => it.product?.vendor)?.product?.vendor;
        if (!seller || !o.invoice) continue;
        const sale = Number(o.invoice.customerTotal); // seller's own revenue from this order
        const commission = Number(o.invoice.remontTotal); // owed to Remont
        const prev = balances.get(seller.id) || 0;
        const next = prev + sale - commission;
        balances.set(seller.id, next);
        ws.addRow({
          partyType: 'SELLER', partyName: seller.businessName,
          date: o.createdAt.toLocaleDateString('en-IN'), ref: o.orderNumber,
          debit: commission, credit: sale, balance: next,
        });
      }
    }

    return toBuffer(wb);
  }
}

@ApiTags('Admin Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Get('gst')
  async gst(@Query('from') from: string, @Query('to') to: string, @Res() res: Response) {
    const buf = await this.reports.generateGstReport(parseRange(from, to));
    sendXlsx(res, buf, 'gst-report.xlsx');
  }

  @Get('accounting')
  async accounting(@Query('from') from: string, @Query('to') to: string, @Res() res: Response) {
    const buf = await this.reports.generateAccountingReport(parseRange(from, to));
    sendXlsx(res, buf, 'accounting-report.xlsx');
  }

  @Get('ledger')
  async ledger(
    @Query('from') from: string, @Query('to') to: string,
    @Query('partyType') partyType: 'CUSTOMER' | 'PARTNER' | 'SELLER' | undefined,
    @Res() res: Response,
  ) {
    const buf = await this.reports.generateLedgerReport(parseRange(from, to), partyType);
    sendXlsx(res, buf, 'ledger-report.xlsx');
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
