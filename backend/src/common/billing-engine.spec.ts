import { calculateInvoice, resolveBillingTransactionType, isValidGstinFormat, stateFromGstin } from './billing-engine';

describe('calculateInvoice', () => {
  // Reference invoice #46 (Bhopal → Berasia transportation), intra-state MP → MP
  it('splits GST into CGST+SGST for an intra-state Remont direct-project invoice', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Transportation from Bhopal to Berasia', qty: 1, rate: 2542.37, taxRatePercent: 18 }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.supplyType).toBe('INTRA_STATE');
    expect(r.taxableValue).toBe(2542.37);
    expect(r.cgst).toBe(228.81);
    expect(r.sgst).toBe(228.81);
    expect(r.igst).toBe(0);
    expect(r.total).toBe(3000);
    expect(r.roundOff).toBe(0.01);
  });

  // Ola-style platform-fee invoice, intra-state
  it('splits GST into CGST+SGST for a small intra-state platform-fee invoice', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Convenience Fees', qty: 1, rate: 4.24, taxRatePercent: 18 }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.cgst).toBe(0.38);
    expect(r.sgst).toBe(0.38);
    expect(r.total).toBe(5);
  });

  // Urban Company-style platform-fee invoice, inter-state (Haryana supplier -> MP customer)
  it('charges IGST when the invoicing entity state differs from the place of supply', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Convenience and Platform Fee', qty: 1, rate: 304.24, taxRatePercent: 18 }],
      supplierState: 'Haryana',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.supplyType).toBe('INTER_STATE');
    expect(r.igst).toBe(54.76);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.total).toBe(359);
  });

  // Urban Company partner receipt — unregistered technician, no GST at all
  it('fabricates no GST fields at all for an unregistered invoicing entity', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Service Charges - Air Conditioner', qty: 1, rate: 998, taxRatePercent: 18 }],
      supplierState: null,
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.supplyType).toBe('UNREGISTERED');
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.igst).toBe(0);
    expect(r.total).toBe(998);
    expect(r.roundOff).toBe(0);
  });

  // Whole-rupee rounding is a GST tax-invoice convention — it must never touch an
  // unregistered party's exact payout, or a partner would be silently shorted a few
  // paise against what's actually owed. Bug found via the ₹399.20 partner-share example
  // in the Type-1 billing correction: an unregistered partner's ₹399.20 was rounding
  // down to ₹399 before this fix.
  it('never whole-rupee-rounds an unregistered party\'s amount — it stays exact to the paisa', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Partner Service Value', qty: 1, rate: 399.20, taxRatePercent: 18 }],
      supplierState: null,
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.total).toBe(399.20);
    expect(r.roundOff).toBe(0);
  });

  it('still whole-rupee-rounds a registered party\'s real tax invoice total', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Remont Platform Fee', qty: 1, rate: 99.80, taxRatePercent: 18 }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.preRoundTotal).toBe(117.76);
    expect(r.total).toBe(118);
    expect(r.roundOff).toBe(0.24);
  });

  it('sums multiple line items and applies discount before computing tax', () => {
    const r = calculateInvoice({
      lines: [
        { description: 'Design fee', qty: 1, rate: 5000, taxRatePercent: 18 },
        { description: 'Material', qty: 2, rate: 1000, discount: 200, taxRatePercent: 18 },
      ],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    // line 2 taxable = 2*1000 - 200 = 1800; total taxable = 5000+1800 = 6800
    expect(r.taxableValue).toBe(6800);
    expect(r.cgst).toBe(612); // 6800*0.09
    expect(r.sgst).toBe(612);
  });

  it('treats old/alternate state names as the same state — no accidental IGST from spelling differences', () => {
    const r = calculateInvoice({
      lines: [{ description: 'x', qty: 1, rate: 100, taxRatePercent: 18 }],
      supplierState: 'Orissa',
      placeOfSupply: 'Odisha',
    });
    expect(r.supplyType).toBe('INTRA_STATE');
    expect(r.igst).toBe(0);
    expect(r.cgst).toBe(9);
  });

  it('is idempotent — identical input always produces identical output', () => {
    const input = {
      lines: [{ description: 'x', qty: 3, rate: 111.11, taxRatePercent: 18 }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Karnataka',
    };
    expect(calculateInvoice(input)).toEqual(calculateInvoice({ ...input }));
  });
});

describe('resolveBillingTransactionType', () => {
  it('classifies product orders as marketplace regardless of vendor staffing', () => {
    expect(resolveBillingTransactionType('PRODUCT', 'IN_HOUSE')).toBe('MARKETPLACE_PRODUCT');
    expect(resolveBillingTransactionType('PRODUCT', 'PARTNER')).toBe('MARKETPLACE_PRODUCT');
  });
  it('classifies in-house-staffed service orders as direct project', () => {
    expect(resolveBillingTransactionType('SERVICE', 'IN_HOUSE')).toBe('DIRECT_PROJECT');
  });
  it('classifies partner-staffed (or unassigned) service orders as platform service', () => {
    expect(resolveBillingTransactionType('SERVICE', 'PARTNER')).toBe('PLATFORM_SERVICE');
    expect(resolveBillingTransactionType('BUNDLE', null)).toBe('PLATFORM_SERVICE');
  });
});

// Phase 8 — GST-Included pricing: back-derive the taxable base from a gross,
// tax-inclusive price instead of adding tax on top of it a second time.
describe('calculateInvoice — GST-Included pricing', () => {
  it('splits an intra-state ₹1,180 inclusive-of-18%-GST line into ₹1,000 taxable + ₹90 CGST + ₹90 SGST', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Product', qty: 1, rate: 1180, taxRatePercent: 18, priceType: 'INCLUSIVE' }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.taxableValue).toBe(1000);
    expect(r.cgst).toBe(90);
    expect(r.sgst).toBe(90);
    expect(r.igst).toBe(0);
    // The line's own amount must equal the original gross exactly — never taxed a second time.
    expect(r.lines[0].amount).toBe(1180);
    expect(r.total).toBe(1180);
  });

  it('splits an inter-state ₹1,180 inclusive-of-18%-GST line into ₹1,000 taxable + ₹180 IGST', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Product', qty: 1, rate: 1180, taxRatePercent: 18, priceType: 'INCLUSIVE' }],
      supplierState: 'Haryana',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.taxableValue).toBe(1000);
    expect(r.igst).toBe(180);
    expect(r.cgst).toBe(0);
    expect(r.sgst).toBe(0);
    expect(r.lines[0].amount).toBe(1180);
    expect(r.total).toBe(1180);
  });

  it('sums a mixed cart of one INCLUSIVE and one EXCLUSIVE line correctly, with no double-taxing', () => {
    const r = calculateInvoice({
      lines: [
        { description: 'Inclusive product', qty: 1, rate: 1180, taxRatePercent: 18, priceType: 'INCLUSIVE' },
        { description: 'Exclusive product', qty: 1, rate: 1000, taxRatePercent: 18, priceType: 'EXCLUSIVE' },
      ],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    // Inclusive line: taxable 1000, tax 180 (embedded). Exclusive line: taxable 1000, tax 180 (added on top).
    expect(r.taxableValue).toBe(2000);
    expect(r.cgst).toBe(180); // 90 + 90
    expect(r.sgst).toBe(180);
    // Inclusive line charges exactly 1180 (unchanged); exclusive line charges 1000+180=1180.
    expect(r.lines[0].amount).toBe(1180);
    expect(r.lines[1].amount).toBe(1180);
    expect(r.preRoundTotal).toBe(2360);
  });

  it('treats an omitted priceType as EXCLUSIVE — every pre-existing call site is unaffected', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Product', qty: 1, rate: 1000, taxRatePercent: 18 }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.lines[0].priceType).toBe('EXCLUSIVE');
    expect(r.taxableValue).toBe(1000);
    expect(r.lines[0].amount).toBe(1180);
  });

  it('an inclusive line with 0% GST has nothing to back out — taxable value equals the gross', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Zero-rated product', qty: 1, rate: 500, taxRatePercent: 0, priceType: 'INCLUSIVE' }],
      supplierState: 'Madhya Pradesh',
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.taxableValue).toBe(500);
    expect(r.cgst).toBe(0);
    expect(r.lines[0].amount).toBe(500);
  });

  it('an inclusive line for an UNREGISTERED supplier fabricates no GST — amount stays exact', () => {
    const r = calculateInvoice({
      lines: [{ description: 'Product', qty: 1, rate: 1180, taxRatePercent: 18, priceType: 'INCLUSIVE' }],
      supplierState: null,
      placeOfSupply: 'Madhya Pradesh',
    });
    expect(r.supplyType).toBe('UNREGISTERED');
    expect(r.taxableValue).toBe(1180);
    expect(r.cgst).toBe(0);
    expect(r.total).toBe(1180);
  });
});

describe('GSTIN helpers', () => {
  it('validates a well-formed GSTIN with a known state code', () => {
    expect(isValidGstinFormat('23AAKCR9036L1ZY')).toBe(true);
    expect(isValidGstinFormat('06AABCU7755Q1ZK')).toBe(true);
  });
  it('rejects malformed or unknown-state GSTINs', () => {
    expect(isValidGstinFormat('not-a-gstin')).toBe(false);
    expect(isValidGstinFormat('99AAKCR9036L1ZY')).toBe(false);
  });
  it('derives the registered state from a GSTIN prefix', () => {
    expect(stateFromGstin('23AAKCR9036L1ZY')).toBe('Madhya Pradesh');
    expect(stateFromGstin('06AABCU7755Q1ZK')).toBe('Haryana');
    expect(stateFromGstin(null)).toBeNull();
  });
});
