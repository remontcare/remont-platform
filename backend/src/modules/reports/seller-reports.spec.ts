import { BadRequestException } from '@nestjs/common';
import Excel from 'exceljs';
import { SellerReportsService, isCountedSale, parseFormat, parseReportRange, parseSalesFilter, parseStockFilter, toCsv } from './seller-reports';
import { ProductVendorsController } from '../vendors/vendors.module';

function item(id: string, o: any, p: any, extra: any = {}) {
  return {
    id, productId: p.id, quantity: 2, unitPrice: 100, totalPrice: 200, gstAmount: 30.51, taxableValue: 169.49,
    product: { name: p.name, sku: p.sku, mrp: 'mrp' in p ? p.mrp : 150, vendorId: p.vendorId, vendor: { businessName: p.seller } },
    order: { customer: { name: 'Asha', phone: '+919811111111' }, address: { city: 'Bhopal', pincode: '462016' }, discountAllocation: null, paymentMethod: 'ONLINE', productFulfillmentStage: 'SELLER_ACCEPTED', ...o },
    ...extra,
  };
}
const P1 = { id: 'p1', name: 'LED Bulb', sku: 'SKU-1', vendorId: 'v1', seller: 'Kumar Electronics' };
const P2 = { id: 'p2', name: 'Tap', sku: 'SKU-2', vendorId: 'v2', seller: 'Other Seller', mrp: null };
const at = new Date('2026-10-08T06:00:00Z');
const ITEMS = [
  item('i1', { id: 'o1', orderNumber: 'ORD-1', createdAt: at, status: 'CONFIRMED', paymentStatus: 'PAID', discountAllocation: { customerDiscountAmount: 20 } }, P1),
  item('i2', { id: 'o2', orderNumber: 'ORD-2', createdAt: at, status: 'CONFIRMED', paymentStatus: 'PAID', productFulfillmentStage: 'SELLER_REJECTED' }, P1),
  item('i3', { id: 'o3', orderNumber: 'ORD-3', createdAt: at, status: 'CANCELLED', paymentStatus: 'PAID' }, P1),
  item('i4', { id: 'o4', orderNumber: 'ORD-4', createdAt: at, status: 'CONFIRMED', paymentStatus: 'PENDING', productFulfillmentStage: 'AWAITING_SELLER' }, P1),
  item('i5', { id: 'o5', orderNumber: 'ORD-5', createdAt: at, status: 'COMPLETED', paymentStatus: 'PAID', productFulfillmentStage: null }, P2, { quantity: 1, unitPrice: 500, totalPrice: 500, gstAmount: null, taxableValue: null }),
];

function makeService(items = ITEMS, refunds: any[] = []) {
  const prisma: any = {
    orderItem: { findMany: jest.fn(async () => items), groupBy: jest.fn(async () => [{ productId: 'p1', _sum: { quantity: 6 } }]) },
    refundRequest: { findMany: jest.fn(async () => refunds) },
    product: {
      findMany: jest.fn(async () => [
        { id: 'p1', name: 'LED Bulb', sku: 'SKU-1', price: 100, stock: 3, isActive: true, updatedAt: at, vendorId: 'v1', category: { name: 'Lighting' }, vendor: { businessName: 'Kumar Electronics' } },
        { id: 'p3', name: 'Fan', sku: 'SKU-3', price: 900, stock: 0, isActive: true, updatedAt: at, vendorId: 'v1', category: null, vendor: { businessName: 'Kumar Electronics' } },
        { id: 'p4', name: 'Old Tap', sku: 'SKU-4', price: 50, stock: 12, isActive: false, updatedAt: at, vendorId: 'v2', category: null, vendor: { businessName: 'Other Seller' } },
      ]),
    },
  };
  return { svc: new SellerReportsService(prisma), prisma };
}

describe('Seller sales report', () => {
  it('counts only paid, non-cancelled, non-rejected orders in totals', async () => {
    const { svc } = makeService();
    const r = await svc.salesReport({}, 'ADMIN');
    expect(r.rows).toHaveLength(5); // every order line is listed…
    expect(r.rows.map((x) => x.counted)).toEqual(['Yes', 'No', 'No', 'No', 'Yes']); // …but only real sales count
    expect(r.totals).toMatchObject({ totalOrders: 2, totalUnitsSold: 3, grossSales: 700, excludedOrders: 3 });
    expect(r.totals.gst).toBe(30.51);
    // MRP discount (150-100)*2 = 100 + coupon 20 on ORD-1; P2 has no MRP.
    expect(r.totals.discounts).toBe(120);
  });

  it('subtracts partial refunds (RefundRequest wallet + gateway) from net sales', async () => {
    const { svc } = makeService(ITEMS, [{ orderId: 'o1', walletCreditAmount: 50, gatewayRefundAmount: 25 }]);
    const r = await svc.salesReport({}, 'ADMIN');
    expect(r.rows[0].refunded).toBe(75);
    expect(r.totals).toMatchObject({ grossSales: 700, refunds: 75, netSales: 625 });
  });

  it('falls back to value − GST when a legacy line has no taxable snapshot', async () => {
    const { svc } = makeService();
    const r = await svc.salesReport({}, 'ADMIN');
    expect(r.rows[4]).toMatchObject({ gst: 0, taxableValue: 500, mrp: null, mrpDiscount: 0 });
  });

  it('scopes the query to the given seller and applies every filter in the database query', async () => {
    const { svc, prisma } = makeService();
    await svc.salesReport({ vendorId: 'v1', from: new Date('2026-10-01'), to: new Date('2026-10-08'), sku: 'sku-1', orderStatus: 'SELLER_ACCEPTED', paymentStatus: 'PAID', q: 'asha', productId: 'p1' }, 'SELLER');
    const where = JSON.stringify(prisma.orderItem.findMany.mock.calls[0][0].where);
    expect(where).toContain('{"product":{"vendorId":"v1"}}');
    expect(where).toContain('"productFulfillmentStage":"SELLER_ACCEPTED"');
    expect(where).toContain('"paymentStatus":"PAID"');
    expect(where).toContain('"productId":"p1"');
    expect(where).toContain('"sku":{"contains":"sku-1","mode":"insensitive"}');
    expect(where).toContain('"type":"PRODUCT"');
  });

  it('a plain order status filters on Order.status', async () => {
    const { svc, prisma } = makeService();
    await svc.salesReport({ orderStatus: 'CANCELLED' }, 'ADMIN');
    expect(JSON.stringify(prisma.orderItem.findMany.mock.calls[0][0].where)).toContain('{"order":{"status":"CANCELLED"}}');
  });

  it('seller rows never carry the customer phone; admin rows do', async () => {
    const { svc } = makeService();
    expect((await svc.salesReport({}, 'SELLER')).rows[0]).not.toHaveProperty('customerPhone');
    expect((await svc.salesReport({}, 'ADMIN')).rows[0].customerPhone).toBe('+919811111111');
  });

  it('admin gets seller-wise and product/SKU-wise breakdowns of counted sales', async () => {
    const { svc } = makeService();
    const r = await svc.salesReport({}, 'ADMIN');
    expect(r.bySeller).toEqual(expect.arrayContaining([
      expect.objectContaining({ sellerName: 'Other Seller', orders: 1, unitsSold: 1, grossSales: 500 }),
      expect.objectContaining({ sellerName: 'Kumar Electronics', orders: 1, unitsSold: 2, grossSales: 200 }),
    ]));
    expect(r.byProduct.map((p) => p.sku)).toEqual(['SKU-2', 'SKU-1']);
    expect((await svc.salesReport({}, 'SELLER')).bySeller).toBeUndefined();
  });

  it('isCountedSale', () => {
    expect(isCountedSale({ status: 'CONFIRMED', paymentStatus: 'PAID', productFulfillmentStage: 'PROCESSING' })).toBe(true);
    expect(isCountedSale({ status: 'REFUNDED', paymentStatus: 'PAID' })).toBe(false);
    expect(isCountedSale({ status: 'CONFIRMED', paymentStatus: 'REFUNDED' })).toBe(false);
    expect(isCountedSale({ status: 'CONFIRMED', paymentStatus: 'PAID', productFulfillmentStage: 'SELLER_REJECTED' })).toBe(false);
  });
});

describe('Seller stock report', () => {
  it('reports stock, sold quantity, availability and the same low/out/live buckets as the catalog', async () => {
    const { svc } = makeService();
    const r = await svc.stockReport({ vendorId: 'v1' }, 'SELLER');
    expect(r.rows[0]).toMatchObject({ sku: 'SKU-1', currentStock: 3, soldQuantity: 6, availableStock: 3, lowStock: 'Yes', outOfStock: 'No', liveStatus: 'Live' });
    expect(r.rows[1]).toMatchObject({ sku: 'SKU-3', availableStock: 0, outOfStock: 'Yes', lowStock: 'No' });
    expect(r.rows[2]).toMatchObject({ sku: 'SKU-4', currentStock: 12, availableStock: 0, liveStatus: 'Not live' }); // inactive → not sellable
    expect(r.totals).toMatchObject({ totalProducts: 3, liveProducts: 2, inactiveProducts: 1, lowStockProducts: 1, outOfStockProducts: 1, totalSoldQuantity: 6 });
    expect(r.bySeller).toBeUndefined();
  });

  it('scopes to the seller and translates the stock-status filter into the query', async () => {
    const { svc, prisma } = makeService();
    await svc.stockReport({ vendorId: 'v1', stockStatus: 'LOW' }, 'SELLER');
    const where = JSON.stringify(prisma.product.findMany.mock.calls[0][0].where);
    expect(where).toContain('{"vendorId":"v1"}');
    expect(where).toContain('{"isActive":true,"stock":{"gt":0,"lte":5}}');
    // sold quantity uses the same "counted sale" rule as the sales report
    expect(JSON.stringify(prisma.orderItem.groupBy.mock.calls[0][0].where)).toContain('"paymentStatus":"PAID"');
  });

  it('admin consolidated report groups by seller', async () => {
    const { svc } = makeService();
    const r = await svc.stockReport({}, 'ADMIN');
    expect(r.bySeller).toEqual([
      expect.objectContaining({ sellerName: 'Kumar Electronics', products: 2, liveProducts: 2, lowStockProducts: 1, outOfStockProducts: 1 }),
      expect.objectContaining({ sellerName: 'Other Seller', products: 1, inactiveProducts: 1 }),
    ]);
  });
});

describe('Report inputs and file output', () => {
  it('parses IST calendar-day ranges and rejects bad input', () => {
    const r = parseReportRange('2026-10-08', '2026-10-08');
    expect(r.from!.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(r.to!.toISOString()).toBe('2026-10-08T18:29:59.999Z');
    expect(() => parseReportRange('08/10/2026')).toThrow(BadRequestException);
    expect(() => parseReportRange('2026-10-09', '2026-10-01')).toThrow('from must be on or before to');
    expect(() => parseSalesFilter({ orderStatus: 'DROP TABLE' })).toThrow(BadRequestException);
    expect(() => parseSalesFilter({ paymentStatus: 'FREE' })).toThrow(BadRequestException);
    expect(() => parseStockFilter({ stockStatus: 'MAYBE' })).toThrow(BadRequestException);
    expect(() => parseFormat('pdf')).toThrow(BadRequestException);
    expect(parseFormat(undefined)).toBe('json');
  });

  it('CSV: BOM, quoting, and spreadsheet-formula neutralising', () => {
    const csv = toCsv([{ header: 'Name', key: 'n' }, { header: 'Qty', key: 'q' }], [{ n: 'Bulb, "9W"', q: 2 }, { n: '=HYPERLINK("x")', q: -3 }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"Bulb, ""9W"""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")",-3`);
  });

  async function capture(fn: (res: any) => Promise<any>) {
    const out: any = { headers: {} };
    const res: any = { setHeader: (k: string, v: string) => { out.headers[k] = v; }, send: (b: any) => { out.body = b; }, json: (b: any) => { out.json = b; } };
    await fn(res);
    return out;
  }

  it('XLSX download: order lines, summary and breakdown sheets with real numbers', async () => {
    const { svc } = makeService();
    const report = await svc.salesReport({}, 'ADMIN');
    const out = await capture((res) => svc.send(res, 'sales', 'xlsx', 'ADMIN', report, 'all-sellers-sales-report'));
    expect(out.headers['Content-Disposition']).toMatch(/attachment; filename="all-sellers-sales-report-\d{4}-\d{2}-\d{2}\.xlsx"/);
    const wb = new Excel.Workbook();
    await wb.xlsx.load(out.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Sales (order lines)', 'Summary', 'By Seller', 'By Product - SKU']);
    const lines = wb.getWorksheet('Sales (order lines)')!;
    expect(lines.rowCount).toBe(6);
    expect(lines.getRow(1).getCell(1).value).toBe('Order ID');
    expect(lines.getRow(2).getCell('E').value).toBe('SKU-1');
    const summary = wb.getWorksheet('Summary')!;
    expect(summary.getRow(4).values).toEqual(expect.arrayContaining(['Total Sales (gross)', 700]));
  });

  it('seller CSV omits admin-only columns; JSON view caps rows but keeps full totals', async () => {
    const { svc } = makeService();
    const report = await svc.salesReport({}, 'SELLER');
    const csv = await capture((res) => svc.send(res, 'sales', 'csv', 'SELLER', report, 'sales-report'));
    const header = String(csv.body).split('\r\n')[0];
    expect(header).not.toContain('Seller');
    expect(header).not.toContain('Customer Phone');
    expect(header).toContain('Order ID,Order Date,Product Name,SKU,Quantity,Selling Price,MRP');
    const view = await capture((res) => svc.send(res, 'sales', 'json', 'SELLER', report, 'x'));
    expect(view.json.data).toMatchObject({ rowsShown: 5, totals: { totalOrders: 2 } });
  });
});

describe('Seller isolation (controller)', () => {
  it('always uses the caller\'s own vendor id, ignoring a vendorId in the query', async () => {
    const pv: any = { requireOwnVendor: jest.fn(async () => ({ id: 'v-own' })) };
    const reports: any = { salesReport: jest.fn(async () => ({})), stockReport: jest.fn(async () => ({})), send: jest.fn() };
    const ctrl = new ProductVendorsController(pv, reports);
    await ctrl.salesReport({ sub: 'user-1' } as any, { vendorId: 'v-someone-else', format: 'csv' }, {} as any);
    await ctrl.stockReport({ sub: 'user-1' } as any, { vendorId: 'v-someone-else' }, {} as any);
    expect(pv.requireOwnVendor).toHaveBeenCalledWith('user-1');
    expect(reports.salesReport.mock.calls[0][0].vendorId).toBe('v-own');
    expect(reports.stockReport.mock.calls[0][0].vendorId).toBe('v-own');
    expect(reports.salesReport.mock.calls[0][1]).toBe('SELLER');
  });

  it('a user with no seller profile gets no report', async () => {
    const pv: any = { requireOwnVendor: jest.fn(async () => { throw new Error('Seller profile not found'); }) };
    const reports: any = { salesReport: jest.fn(), send: jest.fn() };
    const ctrl = new ProductVendorsController(pv, reports);
    await expect(ctrl.salesReport({ sub: 'u' } as any, {}, {} as any)).rejects.toThrow('Seller profile not found');
    expect(reports.salesReport).not.toHaveBeenCalled();
  });
});
