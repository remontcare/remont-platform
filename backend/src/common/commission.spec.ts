import { resolveCommission } from './index';

function makePrisma(rules: any[], siteSetting: any = null) {
  return {
    commissionRule: { findMany: jest.fn(async () => rules) },
    siteSetting: { findUnique: jest.fn(async () => siteSetting) },
  };
}

describe('resolveCommission — category/service/city priority + fallback (Task 9)', () => {
  it('applies a category-level rule to a service with no rule of its own', async () => {
    const prisma = makePrisma([
      { id: 'r1', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'PERCENTAGE', value: 15, priority: 0, stackable: false },
    ]);
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(result.commissionAmount).toBe(150);
    expect(result.ruleId).toBe('r1');
    expect(result.ruleLabel).toContain('Category rule');
  });

  it('a service-level rule OVERRIDES the category-level rule for that specific service', async () => {
    const prisma = makePrisma([
      { id: 'cat-rule', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'PERCENTAGE', value: 15, priority: 0, stackable: false },
      { id: 'svc-rule', scope: 'SERVICE', categoryId: null, serviceId: 'svc-1', cityId: null, commissionType: 'PERCENTAGE', value: 25, priority: 0, stackable: false },
    ]);
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(result.commissionAmount).toBe(250);
    expect(result.ruleId).toBe('svc-rule');
  });

  it('falls back to a service-level rule directly when no category-level rule exists at all', async () => {
    const prisma = makePrisma([
      { id: 'svc-rule', scope: 'SERVICE', categoryId: null, serviceId: 'svc-1', cityId: null, commissionType: 'FLAT', value: 99, priority: 0, stackable: false },
    ]);
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(result.commissionAmount).toBe(99);
    expect(result.ruleId).toBe('svc-rule');
  });

  it('a city-specific rule wins over an "all cities" rule at the same scope', async () => {
    const prisma = makePrisma([
      { id: 'all-cities', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'PERCENTAGE', value: 10, priority: 0, stackable: false },
      { id: 'bhopal-only', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: 'city-bhopal', commissionType: 'PERCENTAGE', value: 20, priority: 0, stackable: false },
    ]);
    // The mock ignores the actual cityId filter in the where-clause (findMany is stubbed
    // to just return everything passed in), so this exercises the in-process specificity
    // ranking, not the Prisma query filter itself.
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: 'city-bhopal', amount: 1000 });
    expect(result.commissionAmount).toBe(200);
    expect(result.ruleId).toBe('bhopal-only');
  });

  it('supports SLAB (tiered) commission by price range', async () => {
    const prisma = makePrisma([
      {
        id: 'slab-rule', scope: 'SERVICE', categoryId: null, serviceId: 'svc-1', cityId: null, commissionType: 'SLAB', value: 0, priority: 0, stackable: false,
        slabJson: [
          { min: 0, max: 500, type: 'PERCENTAGE', value: 10 },
          { min: 501, max: null, type: 'PERCENTAGE', value: 20 },
        ],
      },
    ]);
    const low = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 400 });
    expect(low.commissionAmount).toBe(40);
    const high = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(high.commissionAmount).toBe(200);
  });

  it('stacks a stackable rule on top of the winning rule only when explicitly opted in', async () => {
    const prisma = makePrisma([
      { id: 'base', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'PERCENTAGE', value: 15, priority: 0, stackable: false },
      { id: 'platform-fee', scope: 'CATEGORY', categoryId: 'cat-1', serviceId: null, cityId: null, commissionType: 'FLAT', value: 20, priority: 0, stackable: true },
    ]);
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(result.commissionAmount).toBe(170); // 150 (15%) + 20 flat stacked
    expect(result.ruleLabel).toContain('stacked');
  });

  it('falls back to the SiteSetting default when nothing matches', async () => {
    const prisma = makePrisma([], { value: '12' });
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(result.commissionAmount).toBe(120);
    expect(result.ruleId).toBeNull();
  });

  it('resolves to ₹0 when nothing matches and no default setting exists', async () => {
    const prisma = makePrisma([], null);
    const result = await resolveCommission(prisma, { serviceId: 'svc-1', categoryId: 'cat-1', cityId: null, amount: 1000 });
    expect(result.commissionAmount).toBe(0);
    expect(result.ruleId).toBeNull();
  });
});
