import { resolveTcsRatePercent, computeTcsSplit, checkEInvoiceApplicability, checkEWayBillApplicability } from './index';

/**
 * Phase 7 — GST TCS (Section 52) / e-Invoice / e-Way Bill applicability. Pure/near-pure
 * helper coverage; integration coverage (actual settlement posting, EInvoiceService/
 * EWayBillService) lives in product-ledger.tcs.spec.ts and compliance.module.spec.ts.
 */

describe('resolveTcsRatePercent (C-10)', () => {
  it('returns 0 (nothing withheld) when no TCS TaxConfig row is configured — never assumes a rate', async () => {
    const prisma: any = { taxConfig: { findFirst: jest.fn().mockResolvedValue(null) } };
    expect(await resolveTcsRatePercent(prisma)).toBe(0);
  });

  it('reads the configured rate from the reused TaxConfig table (type=TCS)', async () => {
    const prisma: any = { taxConfig: { findFirst: jest.fn().mockResolvedValue({ rate: 1 }) } };
    expect(await resolveTcsRatePercent(prisma)).toBe(1);
    expect(prisma.taxConfig.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ type: 'TCS', appliesTo: { has: 'MARKETPLACE_PRODUCT_TCS' }, isActive: true }),
    }));
  });
});

describe('computeTcsSplit (C-10)', () => {
  it('splits into CGST+SGST for an intra-state supply (seller in the same state as Remont)', () => {
    const result = computeTcsSplit(10000, 1, 'Madhya Pradesh', 'Madhya Pradesh');
    expect(result.total).toBe(100); // 1% of 10000
    expect(result.cgst).toBe(50);
    expect(result.sgst).toBe(50);
    expect(result.igst).toBe(0);
  });

  it('splits into IGST for an inter-state supply', () => {
    const result = computeTcsSplit(10000, 1, 'Madhya Pradesh', 'Maharashtra');
    expect(result.total).toBe(100);
    expect(result.igst).toBe(100);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
  });

  it('is zero when the rate is zero (unconfigured) — settlement is unaffected', () => {
    const result = computeTcsSplit(10000, 0, 'Madhya Pradesh', 'Madhya Pradesh');
    expect(result.total).toBe(0);
  });

  it('reuses the same state-alias normalization as ordinary GST (e.g. Orissa/Odisha)', () => {
    const result = computeTcsSplit(10000, 1, 'Odisha', 'Orissa');
    expect(result.igst).toBe(0); // recognized as the SAME state, not inter-state
    expect(result.cgst).toBe(50);
  });
});

describe('checkEInvoiceApplicability (e-Invoice)', () => {
  it('not required when the issuer has no GSTIN (unregistered supply)', () => {
    const { required, reason } = checkEInvoiceApplicability({ issuerGstin: null, issuerEInvoicingEnabled: true, recipientGstin: 'X' });
    expect(required).toBe(false);
    expect(reason).toMatch(/no GSTIN/i);
  });

  it('not required when e-Invoicing has not been enabled for this issuer (turnover unconfirmed) — the default for every entity', () => {
    const { required } = checkEInvoiceApplicability({ issuerGstin: '23AAAAA0000A1Z5', issuerEInvoicingEnabled: false, recipientGstin: 'X' });
    expect(required).toBe(false);
  });

  it('not required for a B2C supply (no recipient GSTIN) even if the issuer is fully enabled', () => {
    const { required, reason } = checkEInvoiceApplicability({ issuerGstin: '23AAAAA0000A1Z5', issuerEInvoicingEnabled: true, recipientGstin: null });
    expect(required).toBe(false);
    expect(reason).toMatch(/B2C/i);
  });

  it('required only when ALL THREE conditions hold: registered issuer, enabled, B2B', () => {
    const { required } = checkEInvoiceApplicability({ issuerGstin: '23AAAAA0000A1Z5', issuerEInvoicingEnabled: true, recipientGstin: '06AABCU7755Q1ZK' });
    expect(required).toBe(true);
  });
});

describe('checkEWayBillApplicability (e-Way Bill)', () => {
  it('not required for a SERVICE order — no goods move', () => {
    const { required, reason } = checkEWayBillApplicability({ orderType: 'SERVICE', consignmentValue: 100000, thresholdAmount: 50000 });
    expect(required).toBe(false);
    expect(reason).toMatch(/goods movement/i);
  });

  it('not required when the consignment value is at or below the threshold', () => {
    expect(checkEWayBillApplicability({ orderType: 'PRODUCT', consignmentValue: 50000, thresholdAmount: 50000 }).required).toBe(false);
    expect(checkEWayBillApplicability({ orderType: 'PRODUCT', consignmentValue: 10000, thresholdAmount: 50000 }).required).toBe(false);
  });

  it('required for a PRODUCT order above the configured threshold', () => {
    const { required } = checkEWayBillApplicability({ orderType: 'PRODUCT', consignmentValue: 75000, thresholdAmount: 50000 });
    expect(required).toBe(true);
  });
});
