import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * The existing commission-rule endpoints now also hold the minimum-charge and cancellation-charge
 * rules: fields are whitelisted (no raw body to Prisma), values validated, the two new types are
 * flat non-stackable amounts with no overlapping active rule, and every change is audited.
 */
function makeService(existingRules: any[] = []) {
  const prisma: any = {
    commissionRule: {
      findMany: jest.fn(async () => existingRules),
      findUnique: jest.fn(async ({ where }: any) => existingRules.find((r) => r.id === where.id) || null),
      create: jest.fn(async ({ data }: any) => ({ id: 'new-rule', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ ...existingRules.find((r) => r.id === where.id), ...data })),
      delete: jest.fn(async ({ where }: any) => ({ id: where.id })),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const svc = new AdminService(prisma, { get: () => undefined } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}
const MIN = { ruleType: 'MINIMUM_CHARGE', scope: 'CATEGORY', categoryId: 'cat-1', commissionType: 'FLAT', value: 199 };

describe('Commission-rule admin — rule types, validation, audit', () => {
  it('creates a minimum-charge rule (₹199) and audits it', async () => {
    const { svc, prisma } = makeService();
    await svc.createCommissionRule({ ...MIN, cityId: '' }, 'admin-1');
    expect(prisma.commissionRule.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ruleType: 'MINIMUM_CHARGE', value: 199, cityId: null }) });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'COMMISSION_RULE_CREATED', actorId: 'admin-1' }) }));
  });

  it('₹0 is a valid cancellation charge (no charge)', async () => {
    const { svc, prisma } = makeService();
    await svc.createCommissionRule({ ...MIN, ruleType: 'CANCELLATION_CHARGE', value: 0 }, 'admin-1');
    expect(prisma.commissionRule.create).toHaveBeenCalled();
  });

  it.each([
    [{ ...MIN, commissionType: 'PERCENTAGE', value: 50 }, /flat/],
    [{ ...MIN, stackable: true }, /stackable/],
    [{ ...MIN, value: -5 }, /non-negative/],
    [{ ...MIN, ruleType: 'COMMISSION', commissionType: 'PERCENTAGE', value: 150 }, /exceed 100/],
    [{ ...MIN, ruleType: 'SURGE' }, /ruleType/],
    [{ ...MIN, categoryId: undefined }, /categoryId/],
    [{ ...MIN, validFrom: '2026-12-01', validTo: '2026-11-01' }, /after validFrom/],
  ])('rejects %p', async (input, msg) => {
    const { svc, prisma } = makeService();
    await expect(svc.createCommissionRule(input, 'admin-1')).rejects.toThrow(msg as RegExp);
    expect(prisma.commissionRule.create).not.toHaveBeenCalled();
  });

  it('rejects an overlapping active rule of the same type/target/city', async () => {
    const { svc } = makeService([{ id: 'old', isActive: true, validFrom: null, validTo: null }]);
    await expect(svc.createCommissionRule(MIN, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a non-overlapping future rule (e.g. a new minimum from next month)', async () => {
    const { svc, prisma } = makeService([{ id: 'old', isActive: true, validFrom: null, validTo: new Date('2026-11-01') }]);
    await svc.createCommissionRule({ ...MIN, validFrom: '2026-11-01T00:00:00Z' }, 'admin-1');
    expect(prisma.commissionRule.create).toHaveBeenCalled();
  });

  it('drops fields that are not part of a rule (no mass assignment)', async () => {
    const { svc, prisma } = makeService();
    await svc.createCommissionRule({ ...MIN, id: 'forced', createdAt: '2000-01-01', category: { name: 'x' } }, 'admin-1');
    const data = prisma.commissionRule.create.mock.calls[0][0].data;
    expect(data.id).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
    expect(data.category).toBeUndefined();
  });

  it('existing commission rules still validate as before (percentage within 100)', async () => {
    const { svc, prisma } = makeService();
    await svc.createCommissionRule({ scope: 'SERVICE', serviceId: 's1', commissionType: 'PERCENTAGE', value: '20', priority: '5' }, 'admin-1');
    expect(prisma.commissionRule.create).toHaveBeenCalledWith({ data: expect.objectContaining({ value: 20, priority: 5 }) });
  });

  it('update and delete are audited with before/after', async () => {
    const existing = [{ id: 'r1', ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: 'c', commissionType: 'PERCENTAGE', value: 20, isActive: true }];
    const { svc, prisma } = makeService(existing);
    await svc.updateCommissionRule('r1', { value: 25 }, 'admin-1');
    await svc.deleteCommissionRule('r1', 'admin-1');
    const actions = prisma.auditLog.create.mock.calls.map((c: any) => c[0].data.action);
    expect(actions).toEqual(['COMMISSION_RULE_UPDATED', 'COMMISSION_RULE_DELETED']);
    expect(prisma.auditLog.create.mock.calls[0][0].data.metadata.before.value).toBe(20);
  });
});

describe('Cancellation penalty rules — percentage, minimum, both, or none (admin-configured)', () => {
  const PEN = { ruleType: 'CANCELLATION_CHARGE', scope: 'CATEGORY', categoryId: 'cat-1' };
  it.each([
    ['flat ₹ penalty', { ...PEN, commissionType: 'FLAT', value: 1500 }],
    ['percentage only', { ...PEN, commissionType: 'PERCENTAGE', value: 10 }],
    ['percentage with a minimum', { ...PEN, commissionType: 'PERCENTAGE', value: 10, minimumAmount: 199 }],
    ['no penalty (₹0)', { ...PEN, commissionType: 'FLAT', value: 0 }],
  ])('accepts %s', async (_label, input) => {
    const { svc, prisma } = makeService();
    await svc.createCommissionRule(input, 'admin-1');
    expect(prisma.commissionRule.create).toHaveBeenCalled();
  });
  it('stores the minimum as a number', async () => {
    const { svc, prisma } = makeService();
    await svc.createCommissionRule({ ...PEN, commissionType: 'PERCENTAGE', value: 10, minimumAmount: '199' }, 'admin-1');
    expect(prisma.commissionRule.create.mock.calls[0][0].data.minimumAmount).toBe(199);
  });
  it.each([
    [{ ...PEN, commissionType: 'PERCENTAGE', value: 150 }, /exceed 100/],
    [{ ...PEN, commissionType: 'FLAT', value: 100, minimumAmount: 50 }, /minimumAmount applies only/],
    [{ ...PEN, commissionType: 'PERCENTAGE', value: 10, minimumAmount: -1 }, /non-negative/],
    [{ ...PEN, ruleType: 'MINIMUM_CHARGE', commissionType: 'PERCENTAGE', value: 10 }, /flat/],
    [{ ...PEN, ruleType: 'MINIMUM_CHARGE', commissionType: 'FLAT', value: 199, minimumAmount: 10 }, /minimumAmount applies only/],
    [{ ...PEN, ruleType: 'COMMISSION', commissionType: 'PERCENTAGE', value: 20, minimumAmount: 10 }, /minimumAmount applies only/],
    [{ ...PEN, commissionType: 'SLAB', value: 0 }, /flat ₹ amount or a percentage/],
  ])('rejects %p', async (input, msg) => {
    const { svc, prisma } = makeService();
    await expect(svc.createCommissionRule(input, 'admin-1')).rejects.toThrow(msg as RegExp);
    expect(prisma.commissionRule.create).not.toHaveBeenCalled();
  });
});
