import { financialYearLabel, nextInvoiceDocumentNumber } from './index';

/**
 * Phase 5 (C-07 concurrency, L-01 financial year) — before this, InvoicesService.
 * generateForOrder() derived its invoice number from `await prisma.invoice.count()` (a
 * plain read, no lock) then string-templated `count+1` — the classic
 * read-then-compute-then-insert race, plus no financial-year component at all.
 * nextInvoiceDocumentNumber() replaces that with a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per (series, financial year) — the
 * database's own row-level locking on that one statement is what makes this safe, not
 * anything in this application code. This file proves: (a) the function only ever issues
 * ONE query per call — never a separate read followed by a write — and (b) simulating many
 * overlapping calls against an in-memory stand-in for that atomic statement never produces
 * a duplicate or a gap, and different financial years never share a sequence.
 */

/** A minimal in-memory stand-in for the real `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` statement — atomic per call (no `await` before the read-modify-write), same
 * guarantee Postgres itself provides for the real single-statement upsert. Forces an
 * artificial microtask yield BEFORE incrementing so many concurrently-launched calls
 * genuinely interleave in-flight, the same way concurrent requests would in production —
 * if nextInvoiceDocumentNumber() (or this fake) ever became a separate read-then-write,
 * this would surface it as duplicate numbers below. */
function makeAtomicSequenceTx() {
  const store = new Map<string, number>();
  const queryRaw = jest.fn(async (_strings: TemplateStringsArray, ..._values: any[]) => {
    // params: [id, series, financialYear] — series/FY are the 2nd and 3rd interpolated values.
    const series = _values[1];
    const financialYear = _values[2];
    await Promise.resolve(); // force interleaving among concurrently-launched callers
    const key = `${series}::${financialYear}`;
    const next = (store.get(key) || 0) + 1;
    store.set(key, next);
    return [{ lastNumber: next }];
  });
  return { tx: { $queryRaw: queryRaw }, queryRaw, store };
}

describe('financialYearLabel (L-01)', () => {
  it('a date in the first half of the calendar year belongs to the PRIOR-starting FY', () => {
    expect(financialYearLabel(new Date('2027-02-01'))).toBe('2026-27');
  });
  it('a date from April onward belongs to the FY starting that same calendar year', () => {
    expect(financialYearLabel(new Date('2026-08-30'))).toBe('2026-27');
    expect(financialYearLabel(new Date('2027-04-01'))).toBe('2027-28');
  });
  it('March 31 is still the OLD financial year; April 1 is the new one', () => {
    expect(financialYearLabel(new Date('2027-03-31'))).toBe('2026-27');
    expect(financialYearLabel(new Date('2027-04-01'))).toBe('2027-28');
  });
});

describe('nextInvoiceDocumentNumber (C-07/C-08/L-01)', () => {
  it('issues exactly ONE database call per invocation — never a separate read followed by a write', async () => {
    const { tx, queryRaw } = makeAtomicSequenceTx();
    await nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2026-08-30'));
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('formats as INV-<series token>-<FY>-<6-digit seq>, preserving the existing "INV-" prefix style', async () => {
    const { tx } = makeAtomicSequenceTx();
    const num = await nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2026-08-30'));
    expect(num).toBe('INV-CTI-2026-27-000001');
    const num2 = await nextInvoiceDocumentNumber(tx, 'PLATFORM_FEE_INVOICE', new Date('2026-08-30'));
    expect(num2).toBe('INV-PFI-2026-27-000001'); // independent series — starts its own count at 1
  });

  it('50 concurrent allocations for the SAME series+FY never collide and never skip a number', async () => {
    const { tx } = makeAtomicSequenceTx();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2026-08-30'))),
    );
    const uniqueCount = new Set(results).size;
    expect(uniqueCount).toBe(50); // zero duplicates
    const seqNumbers = results.map((n) => Number(n.split('-').pop())).sort((a, b) => a - b);
    expect(seqNumbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1)); // exactly 1..50, no gaps
  });

  it('concurrent allocations across DIFFERENT series never share or corrupt each other\'s sequence', async () => {
    const { tx } = makeAtomicSequenceTx();
    const [customerNums, vendorNums] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, () => nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2026-08-30')))),
      Promise.all(Array.from({ length: 20 }, () => nextInvoiceDocumentNumber(tx, 'PARTNER_SETTLEMENT_INVOICE', new Date('2026-08-30')))),
    ]);
    expect(new Set(customerNums).size).toBe(20);
    expect(new Set(vendorNums).size).toBe(20);
    expect(customerNums.every((n) => n.startsWith('INV-CTI-'))).toBe(true);
    expect(vendorNums.every((n) => n.startsWith('INV-PSI-'))).toBe(true);
  });

  it('FY 2026-27 and FY 2027-28 are independently scoped — the new year never continues or resets into the old one\'s count', async () => {
    const { tx } = makeAtomicSequenceTx();
    const fy2627a = await nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2026-08-30'));
    const fy2627b = await nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2027-03-31'));
    const fy2728a = await nextInvoiceDocumentNumber(tx, 'CUSTOMER_TAX_INVOICE', new Date('2027-04-01'));
    expect(fy2627a).toBe('INV-CTI-2026-27-000001');
    expect(fy2627b).toBe('INV-CTI-2026-27-000002'); // still within FY 2026-27 — continues its own count
    expect(fy2728a).toBe('INV-CTI-2027-28-000001'); // new FY — starts its OWN sequence at 1, not 3
  });
});
