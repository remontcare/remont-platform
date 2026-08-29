import { buildTaxRateResolver as buildTaxRateResolverFromCommon, PLATFORM_FEE_DEFAULT_RATE, resolveProductGstLine } from './index';

describe('buildTaxRateResolver — different services/products can carry different GST rates', () => {
  function prismaWith(rows: any[]) {
    return { taxConfig: { findMany: jest.fn(async () => rows) } };
  }

  it('matches a line to the TaxConfig row whose HSN/SAC exactly equals the line\'s own HSN/SAC', async () => {
    const prisma = prismaWith([
      { rate: 18, hsnCode: '998714', isActive: true, createdAt: new Date('2026-01-01') }, // AC/appliance repair services
      { rate: 5, hsnCode: '999599', isActive: true, createdAt: new Date('2026-01-02') },  // basic cleaning services
    ]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'SERVICE');
    expect(resolver.rateFor('998714', null)).toBe(18);
    expect(resolver.rateFor('999599', null)).toBe(5);
  });

  it('falls back to the first active blanket rate for the scope when no HSN match exists', async () => {
    const prisma = prismaWith([{ rate: 18, hsnCode: '998714', isActive: true, createdAt: new Date() }]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'SERVICE');
    expect(resolver.rateFor('999999-unmapped', null)).toBe(18);
    expect(resolver.rateFor(null, null)).toBe(18);
  });

  it('a per-item override always wins, even over an HSN match', async () => {
    const prisma = prismaWith([{ rate: 18, hsnCode: '998714', isActive: true, createdAt: new Date() }]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'SERVICE');
    expect(resolver.rateFor('998714', 12)).toBe(12);
    expect(resolver.rateFor('998714', 0)).toBe(0); // an explicit 0% override is respected, not treated as "unset"
  });

  it('defaults ordinary services/products to 0% when nothing is configured — never guesses a rate', async () => {
    const prisma = prismaWith([]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PRODUCT');
    expect(resolver.rateFor('anything', null)).toBe(0);
  });

  it('defaults Remont\'s own platform fee to 18% (SAC 999799) when unconfigured — a real, known rate, not a guess', async () => {
    const prisma = prismaWith([]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
    expect(resolver.rateFor(null, null)).toBe(18);
  });

  it('an admin-configured PLATFORM_FEE TaxConfig row overrides the 18% default', async () => {
    const prisma = prismaWith([{ rate: 12, hsnCode: '999799', isActive: true, createdAt: new Date() }]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
    expect(resolver.rateFor(null, null)).toBe(12);
  });

  it('accepts a Prisma Decimal-shaped override without throwing', async () => {
    const prisma = prismaWith([]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'SERVICE');
    // Prisma Decimal stringifies via toString(); Number() on it works the same as a plain string.
    const fakeDecimal = { toString: () => '28' } as any;
    expect(resolver.rateFor(null, fakeDecimal)).toBe(28);
  });

  // Phase 8 — category-level default, GST applicability, and inclusive/exclusive pricing
  it('a productCategoryId match wins over the blanket default when no HSN match exists', async () => {
    const prisma = prismaWith([
      { rate: 18, hsnCode: null, productCategoryId: null, isActive: true, createdAt: new Date('2026-01-01') },
      { rate: 12, hsnCode: null, productCategoryId: 'cat-1', isActive: true, createdAt: new Date('2026-01-02') },
    ]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PRODUCT');
    expect(resolver.rateFor(null, null, 'cat-1')).toBe(12);
    expect(resolver.rateFor(null, null, 'cat-2')).toBe(18); // no category match — falls to blanket
  });

  it('an HSN match wins over a category match', async () => {
    const prisma = prismaWith([
      { rate: 12, hsnCode: null, productCategoryId: 'cat-1', isActive: true, createdAt: new Date('2026-01-02') },
      { rate: 28, hsnCode: '998714', productCategoryId: null, isActive: true, createdAt: new Date('2026-01-01') },
    ]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PRODUCT');
    expect(resolver.rateFor('998714', null, 'cat-1')).toBe(28);
  });

  it('gstApplicable=false forces the rate to 0 regardless of the configured rate', async () => {
    const prisma = prismaWith([{ rate: 18, hsnCode: '998714', gstApplicable: false, isActive: true, createdAt: new Date() }]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PRODUCT');
    expect(resolver.rateFor('998714', null)).toBe(0);
  });

  it('priceTypeFor resolves INCLUSIVE/EXCLUSIVE via the same override > HSN > category > blanket chain, defaulting to EXCLUSIVE', async () => {
    const prisma = prismaWith([
      { rate: 18, hsnCode: null, productCategoryId: null, priceType: 'GST_EXCLUSIVE', isActive: true, createdAt: new Date('2026-01-01') },
      { rate: 18, hsnCode: '998714', priceType: 'GST_INCLUSIVE', isActive: true, createdAt: new Date('2026-01-02') },
    ]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PRODUCT');
    expect(resolver.priceTypeFor('998714')).toBe('INCLUSIVE');
    expect(resolver.priceTypeFor('unmapped-hsn')).toBe('EXCLUSIVE'); // blanket row
    expect(resolver.priceTypeFor('998714', null, false)).toBe('EXCLUSIVE'); // explicit override wins
    expect(resolver.priceTypeFor('998714', null, true)).toBe('INCLUSIVE');
  });

  it('priceTypeFor defaults to EXCLUSIVE when nothing is configured at all', async () => {
    const prisma = prismaWith([]);
    const resolver = await buildTaxRateResolverFromCommon(prisma, 'PRODUCT');
    expect(resolver.priceTypeFor('anything')).toBe('EXCLUSIVE');
  });
});

describe('resolveProductGstLine', () => {
  function prismaWith(rows: any[]) {
    return { taxConfig: { findMany: jest.fn(async () => rows) } };
  }

  it('EXCLUSIVE: adds GST on top of the line amount', async () => {
    const prodTax = await buildTaxRateResolverFromCommon(prismaWith([{ rate: 18, hsnCode: 'X', priceType: 'GST_EXCLUSIVE', isActive: true, createdAt: new Date() }]), 'PRODUCT');
    const r = await resolveProductGstLine(prodTax, { hsnSac: 'X', gstOverridePercent: null, gstInclusive: null, categoryId: 'cat-1' }, 1000);
    expect(r).toEqual({ taxableValue: 1000, gstAmount: 180, ratePercent: 18, inclusive: false });
  });

  it('INCLUSIVE: back-derives the taxable base from the gross amount, ₹1,180 -> ₹1,000 taxable + ₹180 GST', async () => {
    const prodTax = await buildTaxRateResolverFromCommon(prismaWith([{ rate: 18, hsnCode: 'X', priceType: 'GST_INCLUSIVE', isActive: true, createdAt: new Date() }]), 'PRODUCT');
    const r = await resolveProductGstLine(prodTax, { hsnSac: 'X', gstOverridePercent: null, gstInclusive: null, categoryId: 'cat-1' }, 1180);
    expect(r).toEqual({ taxableValue: 1000, gstAmount: 180, ratePercent: 18, inclusive: true });
  });

  it('a per-product gstInclusive override wins over the resolved TaxConfig row', async () => {
    const prodTax = await buildTaxRateResolverFromCommon(prismaWith([{ rate: 18, hsnCode: 'X', priceType: 'GST_EXCLUSIVE', isActive: true, createdAt: new Date() }]), 'PRODUCT');
    const r = await resolveProductGstLine(prodTax, { hsnSac: 'X', gstOverridePercent: null, gstInclusive: true, categoryId: 'cat-1' }, 1180);
    expect(r.inclusive).toBe(true);
    expect(r.taxableValue).toBe(1000);
  });

  it('0% or unconfigured rate: nothing to back out, taxableValue equals the line amount', async () => {
    const prodTax = await buildTaxRateResolverFromCommon(prismaWith([]), 'PRODUCT');
    const r = await resolveProductGstLine(prodTax, { hsnSac: null, gstOverridePercent: null, gstInclusive: true, categoryId: 'cat-1' }, 500);
    expect(r).toEqual({ taxableValue: 500, gstAmount: 0, ratePercent: 0, inclusive: true });
  });
});
