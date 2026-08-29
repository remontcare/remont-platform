import { AdminService } from './admin.module';

/**
 * Phase 8 — Bulk Fee-Rule Upload. The confirm transaction must only ever CREATE new
 * ProductFeeRule rows (never .update()), so a bulk import can never rewrite a rule a
 * settled order's productFeeBreakdown snapshot already referenced.
 */
function makeService() {
  const created: any[] = [];
  const productUpdates: any[] = [];
  const existingRules: any[] = [];
  const prisma: any = {
    productCategory: { findMany: jest.fn(async () => [{ id: 'cat-1', key: 'CLEANING_SUPPLIES' }]) },
    product: {
      findMany: jest.fn(async ({ where }: any) => {
        const all = [{ id: 'prod-1', sku: 'SKU-001', categoryId: 'cat-1' }];
        if (where.id) return all.filter((p) => where.id.in.includes(p.id));
        if (where.sku) return all.filter((p) => where.sku.in.includes(p.sku));
        return [];
      }),
      update: jest.fn(async ({ where, data }: any) => { productUpdates.push({ where, data }); return { id: where.id, ...data }; }),
    },
    productFeeRule: {
      findMany: jest.fn(async () => existingRules),
      create: jest.fn(async ({ data }: any) => { const row = { id: 'rule-' + created.length, ...data }; created.push(row); return row; }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const svc = new AdminService(prisma, config, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, created, productUpdates };
}

function validCategoryRow(overrides: any = {}) {
  return {
    feeType: 'COMMISSION', scope: 'PRODUCT_CATEGORY', categoryKey: 'CLEANING_SUPPLIES',
    commissionType: 'PERCENTAGE', value: '8', priority: '0', stackable: 'FALSE', isActive: 'TRUE',
    ...overrides,
  };
}

describe('AdminService.validateProductFeeRuleBulkImport', () => {
  it('accepts a well-formed category-scoped row', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow()]);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(0);
    expect(result.validRows[0].data).toMatchObject({ feeType: 'COMMISSION', scope: 'PRODUCT_CATEGORY', productCategoryId: 'cat-1', value: 8 });
  });

  it('resolves a PRODUCT-scoped row by SKU', async () => {
    const { svc } = makeService();
    const row = validCategoryRow({ scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001' });
    const result = await svc.validateProductFeeRuleBulkImport([row]);
    expect(result.validCount).toBe(1);
    expect(result.validRows[0].data.productId).toBe('prod-1');
  });

  it('rejects an unknown feeType with an exact reason', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ feeType: 'BOGUS' })]);
    expect(result.invalidCount).toBe(1);
    expect(result.invalidRows[0].errors[0]).toMatch(/feeType must be one of/);
  });

  it('rejects a PRODUCT_CATEGORY row with an unknown categoryKey', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ categoryKey: 'NOT_A_REAL_CATEGORY' })]);
    expect(result.invalidRows[0].errors[0]).toMatch(/not found/);
  });

  it('rejects a PERCENTAGE value over 100', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ value: '150' })]);
    expect(result.invalidRows[0].errors[0]).toMatch(/<= 100/);
  });

  it('rejects a SLAB row with missing/invalid slabJson', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ commissionType: 'SLAB', value: '', slabJson: 'not json' })]);
    expect(result.invalidRows[0].errors[0]).toMatch(/slabJson/);
  });

  it('rejects validTo before validFrom', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ validFrom: '2026-06-01', validTo: '2026-01-01' })]);
    expect(result.invalidRows[0].errors[0]).toMatch(/validTo must be after validFrom/);
  });

  it('rejects the second of two duplicate rows in the same file', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow(), validCategoryRow()]);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(1);
    expect(result.invalidRows[0].errors[0]).toMatch(/duplicate/);
  });

  it('flags an overlapping active rule as a non-blocking warning, not an error', async () => {
    const { svc, prisma } = makeService();
    prisma.productFeeRule.findMany.mockResolvedValue([{ id: 'existing-1', validFrom: null, validTo: null }]);
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow()]);
    expect(result.validCount).toBe(1); // still valid — overlap is a warning, not a rejection
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].warning).toMatch(/overlaps/);
  });

  it('rejects productGstInclusive/productGstOverridePercent/productHsnSac on a non-PRODUCT-scoped row', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ productGstInclusive: 'INCLUSIVE' })]);
    expect(result.invalidRows[0].errors[0]).toMatch(/can only be set on a PRODUCT-scoped row/);
  });
});

describe('AdminService.confirmProductFeeRuleBulkImport', () => {
  it('only ever calls productFeeRule.create — never .update — for the happy path', async () => {
    const { svc, prisma, created } = makeService();
    const result = await svc.confirmProductFeeRuleBulkImport([validCategoryRow()]);
    expect(result.rulesCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(prisma.productFeeRule.create).toHaveBeenCalled();
    expect(prisma.productFeeRule.update).toBeUndefined(); // never even wired up — nothing in this feature can call it
  });

  it('updates the resolved Product row (not a ProductFeeRule) when GST override columns are present', async () => {
    const { svc, productUpdates } = makeService();
    const row = validCategoryRow({ scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstInclusive: 'INCLUSIVE', productGstOverridePercent: '18' });
    const result = await svc.confirmProductFeeRuleBulkImport([row]);
    expect(result.rulesCreated).toBe(1);
    expect(result.productsUpdated).toBe(1);
    expect(productUpdates).toHaveLength(1);
    expect(productUpdates[0]).toEqual({ where: { id: 'prod-1' }, data: { gstInclusive: true, gstOverridePercent: 18 } });
  });

  it('skips invalid rows and reports them, without creating anything for them', async () => {
    const { svc, created } = makeService();
    const result = await svc.confirmProductFeeRuleBulkImport([validCategoryRow(), validCategoryRow({ feeType: 'BOGUS' })]);
    expect(result.rulesCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it('runs inside a single $transaction', async () => {
    const { svc, prisma } = makeService();
    await svc.confirmProductFeeRuleBulkImport([validCategoryRow()]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
