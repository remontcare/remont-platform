// ═══════════════════════════════════════════════════════════════════════════
// BILLING / GST CALCULATION ENGINE — single source of truth for all GST and
// total math in the app. Every consumer (invoice generation, admin order view,
// payment capture, Excel reports) must call calculateInvoice() or read its
// already-stored output on an Invoice row — never re-derive GST/totals
// independently. Replaces the old computeInvoiceBreakdown(), which always
// split GST as a flat 9%+9% CGST/SGST (no IGST) and fabricated a GST breakup
// on the vendor/partner amount even when that partner isn't GST-registered.
//
// Pure, deterministic functions only — no Prisma/DB access here, so this file
// stays trivially unit-testable and callable from anywhere (checkout, order
// completion, admin invoice generation, reports) without duplication.
// ═══════════════════════════════════════════════════════════════════════════

export type SupplyType = 'INTRA_STATE' | 'INTER_STATE' | 'UNREGISTERED';
export type GstPriceTypeValue = 'INCLUSIVE' | 'EXCLUSIVE';

export interface BillingLineInput {
  description: string;
  hsnSac?: string | null;
  qty: number;
  unit?: string;
  rate: number;
  discount?: number;
  /** GST rate for this line, e.g. 18 for 18%. Ignored (forced to 0) when the invoicing
   * entity itself is unregistered — see supplierState on BillingCalcInput. */
  taxRatePercent: number;
  /** Phase 8 — whether `rate` already has GST baked in (MRP-style, e.g. ₹1,180 inclusive
   * of 18%) or GST is added on top (₹1,000 + 18%). Defaults to 'EXCLUSIVE' when omitted,
   * so every pre-existing call site (which never sets this) is byte-for-byte unchanged. */
  priceType?: GstPriceTypeValue;
}

export interface BillingLineResult {
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
  priceType: GstPriceTypeValue;
}

export interface BillingCalcInput {
  lines: BillingLineInput[];
  /** Invoicing entity's registered GST state. Null/undefined means the invoicing entity
   * (e.g. an unregistered partner or seller) has no GST registration at all — in that
   * case no GST is ever fabricated on any line, regardless of taxRatePercent supplied. */
  supplierState?: string | null;
  /** Recipient's state — who this specific document is being issued to. Not always the
   * customer: a Remont commission invoice to a seller uses the seller's state here. */
  placeOfSupply: string;
}

export interface BillingCalcResult {
  lines: BillingLineResult[];
  supplyType: SupplyType;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Sum of line amounts before the final whole-rupee round-off is applied. */
  preRoundTotal: number;
  /** Visible, stored round-off (can be positive or negative) — never silently absorbed. */
  roundOff: number;
  total: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Older/alternate names for the same GST state that still show up in free-text address
// data (pre-2011 "Orissa", pre-2000 "Uttaranchal", "Pondicherry" vs the official
// "Puducherry", "NCT of Delhi" vs plain "Delhi") — normalized so an intra-state order
// doesn't get wrongly charged IGST just because two records spelled the state differently.
const STATE_ALIASES: Record<string, string> = {
  'orissa': 'odisha',
  'uttaranchal': 'uttarakhand',
  'pondicherry': 'puducherry',
  'nct of delhi': 'delhi',
  'delhi ncr': 'delhi',
};
// Exported (Phase 7) so TCS's own intra/inter-state split (computeTcsSplit(), common/
// index.ts) reuses the exact same normalization instead of a second copy.
export function normalizeState(state?: string | null): string {
  const s = (state || '').trim().toLowerCase();
  return STATE_ALIASES[s] || s;
}

/**
 * Central calculation engine. Order of operations matches the billing spec exactly:
 * line taxable value (qty×rate − discount) → sum → intra vs inter-state split
 * (CGST+SGST vs IGST, decided by supplierState vs placeOfSupply) → sum → round to the
 * nearest whole rupee, matching standard Indian tax-invoice rounding convention (see the
 * reference invoice: taxable ₹2,542.37 + ₹457.62 GST = ₹2,999.99, displayed as a clean
 * ₹3,000 total) → the difference is stored as an explicit roundOff field.
 */
export function calculateInvoice(input: BillingCalcInput): BillingCalcResult {
  const registered = !!(input.supplierState && input.supplierState.trim());
  const supplyType: SupplyType = !registered
    ? 'UNREGISTERED'
    : normalizeState(input.supplierState) === normalizeState(input.placeOfSupply)
      ? 'INTRA_STATE'
      : 'INTER_STATE';

  const lines: BillingLineResult[] = input.lines.map((line) => {
    const discount = line.discount || 0;
    const grossValue = round2(line.qty * line.rate - discount);
    const rate = registered ? line.taxRatePercent : 0;
    const priceType: GstPriceTypeValue = line.priceType === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
    let taxableValue: number, cgst = 0, sgst = 0, igst = 0, amount: number;

    if (priceType !== 'INCLUSIVE' || rate <= 0) {
      // Existing exclusive math, byte-for-byte unchanged — also the correct fallback for
      // an inclusive line with no tax rate at all (nothing to back out).
      taxableValue = grossValue;
      if (rate > 0) {
        if (supplyType === 'INTRA_STATE') {
          cgst = round2((taxableValue * rate) / 2 / 100);
          sgst = cgst;
        } else if (supplyType === 'INTER_STATE') {
          igst = round2((taxableValue * rate) / 100);
        }
      }
      amount = round2(taxableValue + cgst + sgst + igst);
    } else {
      // Phase 8 — price already includes GST: back-derive the taxable base from the gross
      // amount actually charged, rather than adding tax on top of it a second time.
      taxableValue = round2(grossValue / (1 + rate / 100));
      const totalTax = round2(grossValue - taxableValue);
      if (supplyType === 'INTRA_STATE') {
        // Remainder-safe split (same idiom as allocateAcrossGroups()) so cgst+sgst always
        // sums exactly to totalTax, never drifts a paisa from independent rounding.
        cgst = round2(totalTax / 2);
        sgst = round2(totalTax - cgst);
      } else if (supplyType === 'INTER_STATE') {
        igst = totalTax;
      }
      // By construction taxableValue + tax already equals grossValue exactly — use the
      // original gross, not a freshly-summed total, so the line's charged amount never
      // drifts from what the customer was actually shown/charged.
      amount = grossValue;
    }

    return {
      description: line.description,
      hsnSac: line.hsnSac || null,
      qty: line.qty,
      unit: line.unit || 'unit',
      rate: line.rate,
      discount,
      taxRatePercent: rate,
      taxableValue,
      cgst, sgst, igst,
      amount,
      priceType,
    };
  });

  const taxableValue = round2(lines.reduce((s, l) => s + l.taxableValue, 0));
  const cgst = round2(lines.reduce((s, l) => s + l.cgst, 0));
  const sgst = round2(lines.reduce((s, l) => s + l.sgst, 0));
  const igst = round2(lines.reduce((s, l) => s + l.igst, 0));
  const preRoundTotal = round2(taxableValue + cgst + sgst + igst);
  // Whole-rupee rounding is a GST tax-invoice convention (reconciling odd-paise tax
  // amounts into a clean payable figure) — it has no business applying to an
  // UNREGISTERED document, which carries no tax at all. Rounding an unregistered
  // partner's exact ₹399.20 payout down to ₹399 would silently short them by 20 paise
  // against what the ledger actually owes them; that amount stays exact instead.
  const total = supplyType === 'UNREGISTERED' ? preRoundTotal : Math.round(preRoundTotal);
  const roundOff = round2(total - preRoundTotal);

  return { lines, supplyType, taxableValue, cgst, sgst, igst, preRoundTotal, roundOff, total };
}

// ─── Transaction classification ─────────────────────────────────────────────

export type BillingTransactionTypeValue = 'PLATFORM_SERVICE' | 'DIRECT_PROJECT' | 'MARKETPLACE_PRODUCT';

/**
 * Maps the existing Order.type + assigned vendor's StaffType onto the billing
 * classification. Called once at order confirmation and snapshotted onto
 * Order.billingTransactionType — never re-derived later, so a subsequent vendor
 * reassignment can't retroactively change how a past order was invoiced.
 */
export function resolveBillingTransactionType(
  orderType: 'SERVICE' | 'PRODUCT' | 'BUNDLE' | 'AMC_SUBSCRIPTION',
  vendorStaffType?: 'IN_HOUSE' | 'PARTNER' | null,
): BillingTransactionTypeValue {
  if (orderType === 'PRODUCT') return 'MARKETPLACE_PRODUCT';
  return vendorStaffType === 'IN_HOUSE' ? 'DIRECT_PROJECT' : 'PLATFORM_SERVICE';
}

// ─── GSTIN validation & state lookup ────────────────────────────────────────

// Official CBIC 2-digit GST state/UT codes — used both to validate a GSTIN's state
// prefix and to derive a party's registered state directly from their GSTIN, which is
// more authoritative than a free-text address field.
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

const GSTIN_FORMAT = /^([0-9]{2})[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Format + state-code validation (regex per CBIC's published GSTIN structure). Does not
 * recompute the full mod-36 check-digit — that adds no practical safety over the format
 * check for this app's purposes (rejecting obviously-wrong input at data entry). */
export function isValidGstinFormat(gstin: string): boolean {
  const g = (gstin || '').trim().toUpperCase();
  const m = GSTIN_FORMAT.exec(g);
  return !!m && !!GST_STATE_CODES[m[1]];
}

export function stateFromGstin(gstin?: string | null): string | null {
  const g = (gstin || '').trim().toUpperCase();
  const code = g.slice(0, 2);
  return GST_STATE_CODES[code] || null;
}
