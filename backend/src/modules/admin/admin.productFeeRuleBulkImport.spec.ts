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
    taxConfig: { findMany: jest.fn(async () => []) }, // no PRODUCT rates configured — H-03 validation is skipped, unaffected by this Phase 8 test file
    auditLog: { create: jest.fn(async () => ({})) },
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

  // Phase 8 (H-03) — GST slab validation reuses TaxConfig as the source of truth.
  it('rejects a productGstOverridePercent that matches no configured PRODUCT TaxConfig rate', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig = { findMany: jest.fn(async () => [{ rate: 18 }, { rate: 12 }]) };
    const row = validCategoryRow({ scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '19' });
    const result = await svc.validateProductFeeRuleBulkImport([row]);
    expect(result.invalidRows[0].errors[0]).toMatch(/does not match any configured GST rate/);
  });

  it('accepts a productGstOverridePercent that DOES match a configured PRODUCT TaxConfig rate', async () => {
    const { svc, prisma } = makeService();
    prisma.taxConfig = { findMany: jest.fn(async () => [{ rate: 18 }, { rate: 12 }]) };
    const row = validCategoryRow({ scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '18' });
    const result = await svc.validateProductFeeRuleBulkImport([row]);
    expect(result.validCount).toBe(1);
  });

  it('skips GST-rate validation entirely when no PRODUCT TaxConfig is configured yet (never locks out a fresh install)', async () => {
    const { svc } = makeService(); // default mock: taxConfig.findMany() -> []
    const row = validCategoryRow({ scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '37' });
    const result = await svc.validateProductFeeRuleBulkImport([row]);
    expect(result.validCount).toBe(1);
  });

  // Phase 8 (M-02) — conflicting GST update for the same product across different rows.
  it('rejects a second row that sets a DIFFERENT GST value for a product a prior row already updated', async () => {
    const { svc } = makeService();
    const rowA = validCategoryRow({ feeType: 'COMMISSION', scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '18' });
    const rowB = validCategoryRow({ feeType: 'MARKETING', scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '12' });
    const result = await svc.validateProductFeeRuleBulkImport([rowA, rowB]);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(1);
    expect(result.invalidRows[0].errors[0]).toMatch(/conflicting GST update for the same product/);
  });

  it('allows two rows to repeat the IDENTICAL GST update for the same product (harmless, not a conflict)', async () => {
    const { svc } = makeService();
    const rowA = validCategoryRow({ feeType: 'COMMISSION', scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '18' });
    const rowB = validCategoryRow({ feeType: 'MARKETING', scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstOverridePercent: '18' });
    const result = await svc.validateProductFeeRuleBulkImport([rowA, rowB]);
    expect(result.validCount).toBe(2);
    expect(result.invalidCount).toBe(0);
  });

  // Phase 8 (M-03) — backdated validFrom is a warning, never a rejection.
  it('warns (does not reject) on a backdated validFrom', async () => {
    const { svc } = makeService();
    const result = await svc.validateProductFeeRuleBulkImport([validCategoryRow({ validFrom: '2020-01-01' })]);
    expect(result.validCount).toBe(1);
    expect(result.warnings.some((w: any) => w.warning.match(/in the past/))).toBe(true);
  });
});

describe('AdminService.confirmProductFeeRuleBulkImport — audit logging (H-02)', () => {
  it('writes an AuditLog entry attributing the import to the actor, with row counts', async () => {
    const { svc, prisma } = makeService();
    await svc.confirmProductFeeRuleBulkImport([validCategoryRow(), validCategoryRow({ feeType: 'BOGUS' })], 'admin-42', 'ADMIN' as any);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: 'admin-42', actorRole: 'ADMIN', action: 'PRODUCT_FEE_RULE_BULK_IMPORT',
        metadata: expect.objectContaining({ totalRows: 2, successRows: 1, rejectedRows: 1 }),
      }),
    }));
  });

  it('a failed audit-log write never blocks or undoes an already-completed import', async () => {
    const { svc, prisma } = makeService();
    prisma.auditLog.create.mockRejectedValue(new Error('audit db down'));
    const result = await svc.confirmProductFeeRuleBulkImport([validCategoryRow()], 'admin-1', 'ADMIN' as any);
    expect(result.rulesCreated).toBe(1); // import itself still succeeded
  });
});

describe('AdminService.confirmProductFeeRuleBulkImport', () => {
  it('only ever calls productFeeRule.create — never .update — for the happy path', async () => {
    const { svc, prisma, created } = makeService();
    const result = await svc.confirmProductFeeRuleBulkImport([validCategoryRow()], 'admin-1', 'ADMIN' as any);
    expect(result.rulesCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(prisma.productFeeRule.create).toHaveBeenCalled();
    expect(prisma.productFeeRule.update).toBeUndefined(); // never even wired up — nothing in this feature can call it
  });

  it('updates the resolved Product row (not a ProductFeeRule) when GST override columns are present', async () => {
    const { svc, productUpdates } = makeService();
    const row = validCategoryRow({ scope: 'PRODUCT', categoryKey: undefined, productSku: 'SKU-001', productGstInclusive: 'INCLUSIVE', productGstOverridePercent: '18' });
    const result = await svc.confirmProductFeeRuleBulkImport([row], 'admin-1', 'ADMIN' as any);
    expect(result.rulesCreated).toBe(1);
    expect(result.productsUpdated).toBe(1);
    expect(productUpdates).toHaveLength(1);
    expect(productUpdates[0]).toEqual({ where: { id: 'prod-1' }, data: { gstInclusive: true, gstOverridePercent: 18 } });
  });

  it('skips invalid rows and reports them, without creating anything for them', async () => {
    const { svc, created } = makeService();
    const result = await svc.confirmProductFeeRuleBulkImport([validCategoryRow(), validCategoryRow({ feeType: 'BOGUS' })], 'admin-1', 'ADMIN' as any);
    expect(result.rulesCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it('runs inside a single $transaction', async () => {
    const { svc, prisma } = makeService();
    await svc.confirmProductFeeRuleBulkImport([validCategoryRow()], 'admin-1', 'ADMIN' as any);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
