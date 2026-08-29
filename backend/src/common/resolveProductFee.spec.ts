import { resolveProductFee } from './index';

function makePrisma(rules: any[], siteSetting: any = null) {
  return {
    productFeeRule: { findMany: jest.fn(async () => rules) },
    siteSetting: { findUnique: jest.fn(async () => siteSetting) },
  };
}

describe('resolveProductFee — category/product priority + fallback (Phase 7)', () => {
  it('applies a category-level rule to a product with no rule of its own', async () => {
    const prisma = makePrisma([
      { id: 'r1', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', productId: null, commissionType: 'PERCENTAGE', value: 8, priority: 0, stackable: false },
    ]);
    const result = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(result.feeAmount).toBe(80);
    expect(result.ruleId).toBe('r1');
    expect(result.ruleLabel).toContain('Category rule');
  });

  it('a product-level rule OVERRIDES the category-level rule for that specific product', async () => {
    const prisma = makePrisma([
      { id: 'cat-rule', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', productId: null, commissionType: 'PERCENTAGE', value: 8, priority: 0, stackable: false },
      { id: 'prod-rule', scope: 'PRODUCT', productCategoryId: null, productId: 'prod-1', commissionType: 'PERCENTAGE', value: 12, priority: 0, stackable: false },
    ]);
    const result = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(result.feeAmount).toBe(120);
    expect(result.ruleId).toBe('prod-rule');
  });

  it('falls back to a product-level rule directly when no category-level rule exists at all', async () => {
    const prisma = makePrisma([
      { id: 'prod-rule', scope: 'PRODUCT', productCategoryId: null, productId: 'prod-1', commissionType: 'FLAT', value: 25, priority: 0, stackable: false },
    ]);
    const result = await resolveProductFee(prisma, { feeType: 'MARKETING', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(result.feeAmount).toBe(25);
    expect(result.ruleId).toBe('prod-rule');
  });

  it('supports SLAB (tiered) fees by price range', async () => {
    const prisma = makePrisma([
      {
        id: 'slab-rule', scope: 'PRODUCT', productCategoryId: null, productId: 'prod-1', commissionType: 'SLAB', value: 0, priority: 0, stackable: false,
        slabJson: [
          { min: 0, max: 500, type: 'PERCENTAGE', value: 5 },
          { min: 501, max: null, type: 'PERCENTAGE', value: 10 },
        ],
      },
    ]);
    const low = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 400 });
    expect(low.feeAmount).toBe(20);
    const high = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(high.feeAmount).toBe(100);
  });

  it('stacks a stackable rule on top of the winning rule only when explicitly opted in', async () => {
    const prisma = makePrisma([
      { id: 'base', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', productId: null, commissionType: 'PERCENTAGE', value: 8, priority: 0, stackable: false },
      { id: 'extra', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', productId: null, commissionType: 'FLAT', value: 15, priority: 0, stackable: true },
    ]);
    const result = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(result.feeAmount).toBe(95); // 80 (8%) + 15 flat stacked
    expect(result.ruleLabel).toContain('stacked');
  });

  it('falls back to the SiteSetting default_commission_pct ONLY for feeType=COMMISSION when nothing matches', async () => {
    const prisma = makePrisma([], { value: '6' });
    const result = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(result.feeAmount).toBe(60);
    expect(result.ruleId).toBeNull();
  });

  it('resolves to ₹0 for MARKETING/GATEWAY/OTHER when nothing matches — never a hardcoded fallback percentage', async () => {
    const prisma = makePrisma([], { value: '6' }); // even with a commission default configured
    const marketing = await resolveProductFee(prisma, { feeType: 'MARKETING', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(marketing.feeAmount).toBe(0);
    expect(marketing.ruleLabel).toBe('No rule — ₹0');
    const gateway = await resolveProductFee(prisma, { feeType: 'GATEWAY', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(gateway.feeAmount).toBe(0);
  });

  it('resolves COMMISSION to ₹0 when nothing matches and no default setting exists either', async () => {
    const prisma = makePrisma([], null);
    const result = await resolveProductFee(prisma, { feeType: 'COMMISSION', productId: 'prod-1', productCategoryId: 'cat-1', amount: 1000 });
    expect(result.feeAmount).toBe(0);
    expect(result.ruleId).toBeNull();
  });
});
