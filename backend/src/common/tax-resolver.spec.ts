import { buildTaxRateResolver as buildTaxRateResolverFromCommon, PLATFORM_FEE_DEFAULT_RATE } from './index';

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
});
