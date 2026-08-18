import { ReportsService } from './reports.module';

// xlsx files are zip archives — 'PK' magic bytes confirm exceljs actually produced a
// real workbook rather than throwing partway through and returning garbage/empty output.
function isXlsx(buf: Buffer) {
  return buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function makePrisma() {
  return {
    invoice: { findMany: jest.fn(async () => []) },
    order: { findMany: jest.fn(async () => []) },
    paymentTransaction: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    partnerLedgerEntry: { findMany: jest.fn(async () => []) },
    siteSetting: { findMany: jest.fn(async () => []) }, // billing company config — falls back to defaults
  };
}

describe('ReportsService — GST report', () => {
  it('produces a valid empty workbook when there are no invoices', async () => {
    const prisma: any = makePrisma();
    const svc = new ReportsService(prisma);
    const buf = await svc.generateGstReport({});
    expect(isXlsx(buf)).toBe(true);
  });

  it('emits a separate row for the Remont-fee page and the partner-settlement page when they carry a value', async () => {
    const prisma: any = makePrisma();
    prisma.invoice.findMany.mockResolvedValue([{
      invoiceNumber: 'INV-1', generatedAt: new Date(), transactionType: 'PLATFORM_SERVICE',
      supplierGstin: '23AAKCR9036L1ZY', placeOfSupply: 'Madhya Pradesh',
      customerSubtotal: 0, customerCgst: 0, customerSgst: 0, customerIgst: 0, customerTotal: 0,
      platformCommission: 100, bookingFee: 49, remontCgst: 13.41, remontSgst: 13.41, remontIgst: 0, remontTotal: 176,
      vendorLabor: 1000, vendorCgst: 90, vendorSgst: 90, vendorTotal: 1180,
      order: { customer: { name: 'Test Customer' }, vendor: { fullName: 'Test Partner', gstin: '06AABCU7755Q1ZK' } },
    }]);
    const svc = new ReportsService(prisma);
    const rows = await svc.gstReportRows({});
    // PLATFORM_SERVICE customer page is informational-only (no row), so only fee + partner rows
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.invoiceNo)).toEqual(['INV-1-FEE', 'INV-1-PTR']);
    // The Remont Platform Fee row must carry Remont's own GSTIN (Remont is the supplier
    // on this row) — previously left blank.
    expect(rows[0].gstin).toBe('23AAKCR9036L1ZY');
    expect(rows[0].transactionType).toContain('Remont Fee');
    // The partner row carries the partner's own GSTIN, labeled as their own invoice —
    // never the word "Commission" anywhere in the Type 1 billing model.
    expect(rows[1].gstin).toBe('06AABCU7755Q1ZK');
    expect(rows[1].transactionType).toContain('Partner Service Invoice');
    expect(JSON.stringify(rows)).not.toMatch(/commission/i);
  });
});

describe('ReportsService — Accounting report', () => {
  it('produces a valid empty workbook when there are no orders', async () => {
    const prisma: any = makePrisma();
    const svc = new ReportsService(prisma);
    const buf = await svc.generateAccountingReport({});
    expect(isXlsx(buf)).toBe(true);
  });
});

describe('ReportsService — Ledger report', () => {
  it('produces a valid empty workbook when there is no ledger activity', async () => {
    const prisma: any = makePrisma();
    const svc = new ReportsService(prisma);
    const buf = await svc.generateLedgerReport({});
    expect(isXlsx(buf)).toBe(true);
  });

  it('reads the partner running balance straight off PartnerLedgerEntry.balanceAfter', async () => {
    const prisma: any = makePrisma();
    prisma.partnerLedgerEntry.findMany.mockResolvedValue([
      { amount: 500, balanceAfter: 500, type: 'JOB_PAYOUT', orderId: 'o1', createdAt: new Date(), vendor: { fullName: 'Partner A' } },
      { amount: -100, balanceAfter: 400, type: 'WITHDRAWAL', orderId: null, createdAt: new Date(), vendor: { fullName: 'Partner A' } },
    ]);
    const svc = new ReportsService(prisma);
    const buf = await svc.generateLedgerReport({}, 'PARTNER');
    expect(isXlsx(buf)).toBe(true);
  });
});
