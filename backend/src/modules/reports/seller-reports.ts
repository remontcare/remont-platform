import { BadRequestException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import Excel from 'exceljs';
import { PrismaService } from '../../prisma/prisma.module';

// ═══════════════════════════════════════════════════════════════════════════
// Seller sales & stock reports — read straight from existing Order / OrderItem / Product /
// RefundRequest / OrderDiscountAllocation rows (no copy of order or inventory data is kept).
// Used by the seller portal (always scoped to the caller's own ProductVendor — the vendorId
// comes from the JWT, never the request) and by the admin panel (any seller, or all).
// ═══════════════════════════════════════════════════════════════════════════

/** Same threshold the seller dashboard's lowStockCount and both catalog UIs use. */
export const LOW_STOCK_THRESHOLD = 5;
/** Rows returned to the on-screen view; downloads always contain every matching row. */
export const VIEW_ROW_LIMIT = 500;
const EXPORT_ROW_LIMIT = 50_000;

export type ReportFormat = 'json' | 'csv' | 'xlsx';
export type ReportAudience = 'SELLER' | 'ADMIN';

export interface SalesReportFilter {
  vendorId?: string;
  from?: Date;
  to?: Date;
  productId?: string;
  sku?: string;
  orderStatus?: string; // an OrderStatus or a ProductFulfillmentStage value
  paymentStatus?: string;
  q?: string;
}
export type StockStatusFilter = 'LIVE' | 'LOW' | 'OUT' | 'INACTIVE';
export interface StockReportFilter {
  vendorId?: string;
  productId?: string;
  sku?: string;
  stockStatus?: StockStatusFilter;
  q?: string;
}

const ORDER_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED', 'COMPLETED', 'INVOICED', 'CLOSED', 'CANCELLED', 'REFUNDED'];
const FULFILLMENT_STAGES = ['AWAITING_SELLER', 'SELLER_ACCEPTED', 'SELLER_REJECTED', 'PROCESSING', 'READY_FOR_PICKUP', 'HANDED_TO_LOGISTICS'];
const PAYMENT_STATUSES = ['PENDING', 'INITIATED', 'PAID', 'PARTIAL', 'FAILED', 'CANCELLED', 'REFUNDED'];
const STOCK_STATUSES: StockStatusFilter[] = ['LIVE', 'LOW', 'OUT', 'INACTIVE'];

const STAGE_LABEL: Record<string, string> = {
  AWAITING_SELLER: 'Awaiting seller', SELLER_ACCEPTED: 'Accepted', SELLER_REJECTED: 'Rejected by seller',
  PROCESSING: 'Packing', READY_FOR_PICKUP: 'Ready for pickup', HANDED_TO_LOGISTICS: 'Handed to delivery',
};

/**
 * Whether an order counts as a sale — the seller dashboard's rule (payment confirmed, not
 * cancelled/refunded), plus seller-rejected orders, which are never a sale. Full refunds
 * already flip paymentStatus to REFUNDED; partial refunds are subtracted separately from
 * RefundRequest (see salesReport).
 */
export function isCountedSale(o: { status: string; paymentStatus: string; productFulfillmentStage?: string | null }): boolean {
  return o.paymentStatus === 'PAID' && o.status !== 'CANCELLED' && o.status !== 'REFUNDED' && o.productFulfillmentStage !== 'SELLER_REJECTED';
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const DAY_MS = 86_400_000;
const IST_OFFSET = '+05:30';

/** YYYY-MM-DD dates, interpreted as Indian calendar days (the business's time zone). */
export function parseReportRange(from?: string, to?: string): { from?: Date; to?: Date } {
  const parse = (s: string, label: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequestException(`${label} must be a date in YYYY-MM-DD format`);
    const d = new Date(`${s}T00:00:00${IST_OFFSET}`);
    if (isNaN(d.getTime())) throw new BadRequestException(`${label} is not a valid date`);
    return d;
  };
  const f = from ? parse(from, 'from') : undefined;
  const t = to ? new Date(parse(to, 'to').getTime() + DAY_MS - 1) : undefined; // inclusive end of day
  if (f && t && f > t) throw new BadRequestException('from must be on or before to');
  return { from: f, to: t };
}

export function parseFormat(format?: string): ReportFormat {
  if (!format || format === 'json') return 'json';
  if (format === 'csv' || format === 'xlsx') return format;
  throw new BadRequestException('format must be json, csv or xlsx');
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (!value) return undefined;
  if (!allowed.includes(value as T)) throw new BadRequestException(`Invalid ${label}`);
  return value as T;
}

export function parseSalesFilter(q: Record<string, string | undefined>): Omit<SalesReportFilter, 'vendorId'> {
  const range = parseReportRange(q.from, q.to);
  return {
    ...range,
    productId: q.productId || undefined,
    sku: q.sku?.trim() || undefined,
    orderStatus: pick(q.orderStatus, [...ORDER_STATUSES, ...FULFILLMENT_STAGES], 'order status'),
    paymentStatus: pick(q.paymentStatus, PAYMENT_STATUSES, 'payment status'),
    q: q.q?.trim() || undefined,
  };
}

export function parseStockFilter(q: Record<string, string | undefined>): Omit<StockReportFilter, 'vendorId'> {
  return {
    productId: q.productId || undefined,
    sku: q.sku?.trim() || undefined,
    stockStatus: pick(q.stockStatus as StockStatusFilter, STOCK_STATUSES, 'stock status'),
    q: q.q?.trim() || undefined,
  };
}

interface Column { header: string; key: string; width?: number; money?: boolean; admin?: boolean }

const SALES_COLUMNS: Column[] = [
  { header: 'Order ID', key: 'orderNumber', width: 20 },
  { header: 'Order Date', key: 'orderDate', width: 12 },
  { header: 'Seller', key: 'sellerName', width: 22, admin: true },
  { header: 'Product Name', key: 'productName', width: 28 },
  { header: 'SKU', key: 'sku', width: 18 },
  { header: 'Quantity', key: 'quantity', width: 9 },
  { header: 'Selling Price', key: 'sellingPrice', width: 13, money: true },
  { header: 'MRP', key: 'mrp', width: 11, money: true },
  { header: 'Discount (MRP − Price)', key: 'mrpDiscount', width: 14, money: true },
  { header: 'Coupon Discount', key: 'couponDiscount', width: 13, money: true },
  { header: 'Taxable Value', key: 'taxableValue', width: 13, money: true },
  { header: 'GST', key: 'gst', width: 11, money: true },
  { header: 'Order Value', key: 'orderValue', width: 13, money: true },
  { header: 'Refunded', key: 'refunded', width: 11, money: true },
  { header: 'Order Status', key: 'orderStatus', width: 20 },
  { header: 'Payment Status', key: 'paymentStatus', width: 12 },
  { header: 'Payment Method', key: 'paymentMethod', width: 12 },
  { header: 'Customer', key: 'customerName', width: 18 },
  { header: 'Customer Phone', key: 'customerPhone', width: 15, admin: true },
  { header: 'Delivery City', key: 'deliveryCity', width: 14 },
  { header: 'Delivery PIN', key: 'deliveryPincode', width: 10 },
  { header: 'Counted in Sales', key: 'counted', width: 10 },
];

const STOCK_COLUMNS: Column[] = [
  { header: 'Seller', key: 'sellerName', width: 22, admin: true },
  { header: 'Product Name', key: 'productName', width: 28 },
  { header: 'SKU', key: 'sku', width: 18 },
  { header: 'Category', key: 'category', width: 16 },
  { header: 'Price', key: 'price', width: 11, money: true },
  { header: 'Current Stock', key: 'currentStock', width: 11 },
  { header: 'Sold Quantity', key: 'soldQuantity', width: 11 },
  { header: 'Available Stock', key: 'availableStock', width: 12 },
  { header: 'Low Stock', key: 'lowStock', width: 9 },
  { header: 'Out of Stock', key: 'outOfStock', width: 10 },
  { header: 'Live Status', key: 'liveStatus', width: 10 },
  { header: 'Last Updated', key: 'lastUpdated', width: 18 },
];

const forAudience = (cols: Column[], a: ReportAudience) => cols.filter((c) => !c.admin || a === 'ADMIN');
const fmtDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
const fmtDateTime = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

@Injectable()
export class SellerReportsService {
  constructor(private prisma: PrismaService) {}

  // ─── Sales ────────────────────────────────────────────────────────────────
  async salesReport(filter: SalesReportFilter, audience: ReportAudience, limit = EXPORT_ROW_LIMIT) {
    const and: any[] = [{ order: { type: 'PRODUCT' } }];
    if (filter.vendorId) and.push({ product: { vendorId: filter.vendorId } });
    if (filter.from || filter.to) and.push({ order: { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } });
    if (filter.productId) and.push({ productId: filter.productId });
    if (filter.sku) and.push({ product: { sku: { contains: filter.sku, mode: 'insensitive' } } });
    if (filter.orderStatus) {
      and.push(FULFILLMENT_STAGES.includes(filter.orderStatus)
        ? { order: { productFulfillmentStage: filter.orderStatus } }
        : { order: { status: filter.orderStatus } });
    }
    if (filter.paymentStatus) and.push({ order: { paymentStatus: filter.paymentStatus } });
    if (filter.q) {
      const c = { contains: filter.q, mode: 'insensitive' };
      and.push({ OR: [{ order: { orderNumber: c } }, { product: { name: c } }, { product: { sku: c } }, { order: { customer: { name: c } } }] });
    }

    const items = await this.prisma.orderItem.findMany({
      where: { AND: and },
      include: {
        product: { select: { name: true, sku: true, mrp: true, vendorId: true, vendor: { select: { businessName: true } } } },
        order: {
          select: {
            id: true, orderNumber: true, createdAt: true, status: true, paymentStatus: true, paymentMethod: true,
            productFulfillmentStage: true,
            customer: { select: { name: true, phone: true } },
            address: { select: { city: true, pincode: true } },
            discountAllocation: { select: { customerDiscountAmount: true } },
          },
        },
      },
      orderBy: [{ order: { createdAt: 'desc' } }, { id: 'asc' }],
      take: limit + 1,
    });
    const truncated = items.length > limit;
    if (truncated) items.length = limit;

    // Money that actually moved back to the customer (wallet + gateway) per order — the
    // RefundsService's own source of truth; a full refund also flips paymentStatus.
    const orderIds = [...new Set(items.map((i) => i.order.id))];
    const refunds = orderIds.length
      ? await this.prisma.refundRequest.findMany({
          where: { orderId: { in: orderIds }, approvedAt: { not: null } },
          select: { orderId: true, walletCreditAmount: true, gatewayRefundAmount: true },
        })
      : [];
    const refundedByOrder = new Map<string, number>();
    for (const r of refunds) refundedByOrder.set(r.orderId!, (refundedByOrder.get(r.orderId!) || 0) + num(r.walletCreditAmount) + num(r.gatewayRefundAmount));

    // Order-level amounts (coupon, refund) are spread over that order's lines by value.
    const orderLineTotal = new Map<string, number>();
    for (const it of items) orderLineTotal.set(it.order.id, (orderLineTotal.get(it.order.id) || 0) + num(it.totalPrice));
    const share = (orderId: string, amount: number, lineValue: number) => {
      const total = orderLineTotal.get(orderId) || 0;
      return total > 0 ? round2((amount * lineValue) / total) : 0;
    };

    const rows = items.map((it) => {
      const o = it.order;
      const qty = it.quantity;
      const price = num(it.unitPrice);
      const value = num(it.totalPrice);
      const mrp = it.product.mrp != null ? num(it.product.mrp) : null;
      const gst = it.gstAmount != null ? num(it.gstAmount) : 0;
      const counted = isCountedSale(o);
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        orderDate: fmtDate(o.createdAt),
        sellerId: it.product.vendorId,
        sellerName: it.product.vendor?.businessName || '',
        productId: it.productId,
        productName: it.product.name,
        sku: it.product.sku,
        quantity: qty,
        sellingPrice: price,
        mrp,
        mrpDiscount: mrp != null && mrp > price ? round2((mrp - price) * qty) : 0,
        couponDiscount: share(o.id, num(o.discountAllocation?.customerDiscountAmount), value),
        taxableValue: it.taxableValue != null ? num(it.taxableValue) : round2(value - gst),
        gst,
        orderValue: value,
        refunded: share(o.id, refundedByOrder.get(o.id) || 0, value),
        orderStatus: o.productFulfillmentStage ? STAGE_LABEL[o.productFulfillmentStage] || o.productFulfillmentStage : o.status,
        orderStatusCode: o.status,
        fulfillmentStage: o.productFulfillmentStage,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod || '',
        customerName: o.customer?.name || '',
        ...(audience === 'ADMIN' ? { customerPhone: o.customer?.phone || '' } : {}),
        deliveryCity: o.address?.city || '',
        deliveryPincode: o.address?.pincode || '',
        counted: counted ? 'Yes' : 'No',
      };
    });

    const sold = rows.filter((r) => r.counted === 'Yes');
    const sum = (list: typeof rows, k: 'quantity' | 'orderValue' | 'mrpDiscount' | 'couponDiscount' | 'gst' | 'taxableValue' | 'refunded') =>
      round2(list.reduce((s, r) => s + num(r[k]), 0));
    const totals = {
      totalOrders: new Set(sold.map((r) => r.orderId)).size,
      totalUnitsSold: sold.reduce((s, r) => s + r.quantity, 0),
      grossSales: sum(sold, 'orderValue'),
      discounts: round2(sum(sold, 'mrpDiscount') + sum(sold, 'couponDiscount')),
      taxableValue: sum(sold, 'taxableValue'),
      gst: sum(sold, 'gst'),
      refunds: sum(sold, 'refunded'),
      netSales: round2(sum(sold, 'orderValue') - sum(sold, 'refunded')),
      excludedOrders: new Set(rows.filter((r) => r.counted === 'No').map((r) => r.orderId)).size,
      lineCount: rows.length,
    };

    const group = (keyOf: (r: (typeof rows)[number]) => string, label: (r: (typeof rows)[number]) => Record<string, unknown>) => {
      const m = new Map<string, any>();
      for (const r of sold) {
        const k = keyOf(r);
        if (!m.has(k)) m.set(k, { ...label(r), orders: new Set<string>(), unitsSold: 0, grossSales: 0, discounts: 0, gst: 0, refunds: 0 });
        const g = m.get(k);
        g.orders.add(r.orderId); g.unitsSold += r.quantity; g.grossSales += r.orderValue;
        g.discounts += r.mrpDiscount + r.couponDiscount; g.gst += r.gst; g.refunds += r.refunded;
      }
      return [...m.values()].map((g) => ({
        ...g, orders: g.orders.size, grossSales: round2(g.grossSales), discounts: round2(g.discounts), gst: round2(g.gst),
        refunds: round2(g.refunds), netSales: round2(g.grossSales - g.refunds),
      })).sort((a, b) => b.grossSales - a.grossSales);
    };
    const byProduct = group((r) => r.productId, (r) => ({ productName: r.productName, sku: r.sku, sellerName: r.sellerName }));
    const bySeller = audience === 'ADMIN' ? group((r) => r.sellerId || '', (r) => ({ sellerName: r.sellerName })) : undefined;

    return { totals, rows, byProduct, ...(bySeller ? { bySeller } : {}), truncated };
  }

  // ─── Stock ────────────────────────────────────────────────────────────────
  async stockReport(filter: StockReportFilter, audience: ReportAudience) {
    const and: any[] = [];
    if (filter.vendorId) and.push({ vendorId: filter.vendorId });
    else and.push({ vendorId: { not: null } });
    if (filter.productId) and.push({ id: filter.productId });
    if (filter.sku) and.push({ sku: { contains: filter.sku, mode: 'insensitive' } });
    if (filter.q) {
      const c = { contains: filter.q, mode: 'insensitive' };
      and.push({ OR: [{ name: c }, { sku: c }, { brand: c }] });
    }
    // Same buckets as the seller portal / app catalog filters.
    if (filter.stockStatus === 'LIVE') and.push({ isActive: true, stock: { gt: 0 } });
    if (filter.stockStatus === 'LOW') and.push({ isActive: true, stock: { gt: 0, lte: LOW_STOCK_THRESHOLD } });
    if (filter.stockStatus === 'OUT') and.push({ isActive: true, stock: { lte: 0 } });
    if (filter.stockStatus === 'INACTIVE') and.push({ isActive: false });

    const products = await this.prisma.product.findMany({
      where: { AND: and },
      select: {
        id: true, name: true, sku: true, price: true, stock: true, isActive: true, updatedAt: true, vendorId: true,
        category: { select: { name: true } }, vendor: { select: { businessName: true } },
      },
      orderBy: [{ vendorId: 'asc' }, { name: 'asc' }],
      take: EXPORT_ROW_LIMIT,
    });

    // Sold quantity = units on orders that count as sales (same rule as the sales report).
    // Checkout already decremented Product.stock for these, so stock IS what is left to sell.
    const ids = products.map((p) => p.id);
    const soldItems = ids.length
      ? await this.prisma.orderItem.groupBy({
          by: ['productId'],
          where: {
            productId: { in: ids },
            order: { paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'REFUNDED'] }, NOT: { productFulfillmentStage: 'SELLER_REJECTED' } },
          },
          _sum: { quantity: true },
        })
      : [];
    const soldBy = new Map(soldItems.map((s: any) => [s.productId, num(s._sum?.quantity)]));

    const rows = products.map((p) => {
      const stock = p.stock;
      return {
        productId: p.id,
        sellerId: p.vendorId,
        sellerName: p.vendor?.businessName || '',
        productName: p.name,
        sku: p.sku,
        category: p.category?.name || '',
        price: num(p.price),
        currentStock: stock,
        soldQuantity: soldBy.get(p.id) || 0,
        availableStock: p.isActive ? Math.max(stock, 0) : 0, // what customers can actually buy now
        lowStock: p.isActive && stock > 0 && stock <= LOW_STOCK_THRESHOLD ? 'Yes' : 'No',
        outOfStock: stock <= 0 ? 'Yes' : 'No',
        liveStatus: p.isActive ? 'Live' : 'Not live',
        lastUpdated: fmtDateTime(p.updatedAt),
      };
    });

    const totals = {
      totalProducts: rows.length,
      liveProducts: rows.filter((r) => r.liveStatus === 'Live').length,
      inactiveProducts: rows.filter((r) => r.liveStatus !== 'Live').length,
      lowStockProducts: rows.filter((r) => r.lowStock === 'Yes').length,
      outOfStockProducts: rows.filter((r) => r.liveStatus === 'Live' && r.outOfStock === 'Yes').length,
      totalCurrentStock: rows.reduce((s, r) => s + r.currentStock, 0),
      totalAvailableStock: rows.reduce((s, r) => s + r.availableStock, 0),
      totalSoldQuantity: rows.reduce((s, r) => s + r.soldQuantity, 0),
    };

    let bySeller: any[] | undefined;
    if (audience === 'ADMIN') {
      const m = new Map<string, any>();
      for (const r of rows) {
        const k = r.sellerId || '';
        if (!m.has(k)) m.set(k, { sellerName: r.sellerName, products: 0, liveProducts: 0, lowStockProducts: 0, outOfStockProducts: 0, inactiveProducts: 0, availableStock: 0, soldQuantity: 0 });
        const g = m.get(k);
        g.products++; g.availableStock += r.availableStock; g.soldQuantity += r.soldQuantity;
        if (r.liveStatus === 'Live') g.liveProducts++; else g.inactiveProducts++;
        if (r.lowStock === 'Yes') g.lowStockProducts++;
        if (r.liveStatus === 'Live' && r.outOfStock === 'Yes') g.outOfStockProducts++;
      }
      bySeller = [...m.values()].sort((a, b) => a.sellerName.localeCompare(b.sellerName));
    }
    return { totals, rows, ...(bySeller ? { bySeller } : {}) };
  }

  // ─── Output ───────────────────────────────────────────────────────────────

  /** JSON for the on-screen view (rows capped, totals over everything), or a file download. */
  async send(
    res: Response, kind: 'sales' | 'stock', format: ReportFormat, audience: ReportAudience,
    report: { totals: Record<string, number>; rows: any[]; byProduct?: any[]; bySeller?: any[]; truncated?: boolean },
    filenameBase: string,
  ) {
    if (format === 'json') {
      return res.json({
        success: true,
        data: {
          ...report,
          rows: report.rows.slice(0, VIEW_ROW_LIMIT),
          byProduct: report.byProduct?.slice(0, VIEW_ROW_LIMIT),
          rowsShown: Math.min(report.rows.length, VIEW_ROW_LIMIT),
        },
      });
    }
    const columns = forAudience(kind === 'sales' ? SALES_COLUMNS : STOCK_COLUMNS, audience);
    const stamp = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const filename = `${filenameBase}-${stamp}.${format}`;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(toCsv(columns, report.rows));
    }
    const buf = await this.toXlsx(kind, columns, report, audience);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buf);
  }

  private async toXlsx(kind: 'sales' | 'stock', columns: Column[], report: any, audience: ReportAudience): Promise<Buffer> {
    const wb = new Excel.Workbook();
    wb.creator = 'Remont India';
    const addSheet = (name: string, cols: Column[], rows: any[]) => {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width || 14, style: c.money ? { numFmt: '#,##0.00' } : {} }));
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F0E8' } };
      for (const r of rows) ws.addRow(r);
      if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
      return ws;
    };

    addSheet(kind === 'sales' ? 'Sales (order lines)' : 'Stock', columns, report.rows);

    const summary = wb.addWorksheet('Summary');
    summary.columns = [{ header: 'Metric', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 18 }];
    summary.getRow(1).font = { bold: true };
    const labels: Record<string, string> = {
      totalOrders: 'Total Orders', totalUnitsSold: 'Total Units Sold', grossSales: 'Total Sales (gross)', discounts: 'Discounts',
      taxableValue: 'Taxable Value', gst: 'GST', refunds: 'Refunds', netSales: 'Net Sales (after refunds)',
      excludedOrders: 'Orders not counted (unpaid / cancelled / rejected / refunded)', lineCount: 'Order lines in report',
      totalProducts: 'Products', liveProducts: 'Live Products', inactiveProducts: 'Inactive Products', lowStockProducts: 'Low Stock Products',
      outOfStockProducts: 'Out of Stock Products (live)', totalCurrentStock: 'Total Current Stock', totalAvailableStock: 'Total Available Stock',
      totalSoldQuantity: 'Total Sold Quantity',
    };
    for (const [k, v] of Object.entries(report.totals)) summary.addRow({ k: labels[k] || k, v });
    summary.addRow({});
    summary.addRow({ k: kind === 'sales'
      ? 'Sales count only paid orders that are not cancelled, refunded or rejected by the seller. Refunds include partial refunds.'
      : `Low stock = live product with 1–${LOW_STOCK_THRESHOLD} units. Sold quantity counts paid, non-cancelled, non-rejected orders.` });

    if (kind === 'sales') {
      const groupCols = (first: Column[]): Column[] => [
        ...first,
        { header: 'Orders', key: 'orders', width: 9 }, { header: 'Units Sold', key: 'unitsSold', width: 10 },
        { header: 'Gross Sales', key: 'grossSales', width: 13, money: true }, { header: 'Discounts', key: 'discounts', width: 12, money: true },
        { header: 'GST', key: 'gst', width: 11, money: true }, { header: 'Refunds', key: 'refunds', width: 11, money: true },
        { header: 'Net Sales', key: 'netSales', width: 13, money: true },
      ];
      if (audience === 'ADMIN' && report.bySeller) addSheet('By Seller', groupCols([{ header: 'Seller', key: 'sellerName', width: 24 }]), report.bySeller);
      addSheet('By Product - SKU', groupCols([
        { header: 'Product', key: 'productName', width: 28 }, { header: 'SKU', key: 'sku', width: 18 },
        ...(audience === 'ADMIN' ? [{ header: 'Seller', key: 'sellerName', width: 22 }] : []),
      ]), report.byProduct || []);
    } else if (audience === 'ADMIN' && report.bySeller) {
      addSheet('By Seller', [
        { header: 'Seller', key: 'sellerName', width: 24 }, { header: 'Products', key: 'products', width: 10 },
        { header: 'Live', key: 'liveProducts', width: 8 }, { header: 'Inactive', key: 'inactiveProducts', width: 9 },
        { header: 'Low Stock', key: 'lowStockProducts', width: 10 }, { header: 'Out of Stock', key: 'outOfStockProducts', width: 11 },
        { header: 'Available Stock', key: 'availableStock', width: 13 }, { header: 'Sold Quantity', key: 'soldQuantity', width: 12 },
      ], report.bySeller);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

/** RFC 4180 CSV with a UTF-8 BOM (so Excel shows ₹/Hindi text correctly). Cells that look
 * like formulas are prefixed with ' so a product name can never execute in a spreadsheet. */
export function toCsv(columns: { header: string; key: string }[], rows: any[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
