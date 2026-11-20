import { BadRequestException } from '@nestjs/common';
import { ServiceVendorsService } from './vendors.module';

/**
 * Registration must not accept a skill/city typo that dispatch can never match (skills are
 * matched against ServiceCategory keys, baseCity against the order's city). Existing partner
 * values stay valid so current records and the resume/re-submit flow keep working.
 */
function makeService(opts: { existing?: any; categories?: string[]; cities?: string[] } = {}) {
  const prisma: any = {
    serviceVendor: {
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      upsert: jest.fn(async (args: any) => ({ id: 'v1', ...args.create, ...args.update })),
    },
    serviceCategory: { findMany: jest.fn().mockResolvedValue((opts.categories ?? ['electrical', 'plumbing', 'ac-repair']).map((key) => ({ key }))) },
    city: { findMany: jest.fn().mockResolvedValue((opts.cities ?? ['Bhopal', 'Indore']).map((name) => ({ name }))) },
  };
  const ledger: any = { getBaseHoldDefault: jest.fn().mockResolvedValue(1000) };
  return { service: new ServiceVendorsService(prisma, {} as any, { emit: jest.fn() } as any, ledger), prisma };
}

describe('ServiceVendorsService.register — skill/city matching', () => {
  it('accepts a valid category + city and stores the canonical city spelling', async () => {
    const { service, prisma } = makeService();
    await service.register('u1', { fullName: 'Ramesh', baseCity: 'bhopal', skills: ['ELECTRICAL'] });
    const args = prisma.serviceVendor.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ baseCity: 'Bhopal', skills: ['ELECTRICAL'] });
  });

  it('accepts a category whose key is stored in a different case/format (ac-repair → AC_REPAIR)', async () => {
    const { service } = makeService();
    await expect(service.register('u1', { fullName: 'R', baseCity: 'Bhopal', skills: ['AC_REPAIR'] })).resolves.toBeDefined();
  });

  it('rejects a skill that matches no category (typo would never be dispatched)', async () => {
    const { service, prisma } = makeService();
    await expect(service.register('u1', { fullName: 'R', baseCity: 'Bhopal', skills: ['Electricain'] }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.serviceVendor.upsert).not.toHaveBeenCalled();
  });

  it('rejects a city Remont does not serve / misspelt', async () => {
    const { service, prisma } = makeService();
    await expect(service.register('u1', { fullName: 'R', baseCity: 'Bhopl', skills: ['ELECTRICAL'] }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.serviceVendor.upsert).not.toHaveBeenCalled();
  });

  it('existing partner record: legacy skill/city values already on file keep working on re-submit', async () => {
    const { service, prisma } = makeService({
      existing: { id: 'v1', status: 'PENDING_VERIFICATION', skills: ['AC_TECHNICIAN'], baseCity: 'Old Town' },
    });
    await service.register('u1', { fullName: 'R', baseCity: 'Old Town', skills: ['AC Technician'] });
    expect(prisma.serviceVendor.upsert).toHaveBeenCalled();
  });

  it('active partner: city is not rewritten (city changes stay admin-reviewed) and not re-validated', async () => {
    const { service, prisma } = makeService({ existing: { id: 'v1', status: 'ACTIVE', skills: ['ELECTRICAL'], baseCity: 'Legacyville' } });
    await service.register('u1', { fullName: 'R', baseCity: 'Elsewhere', skills: ['ELECTRICAL'] });
    expect(prisma.serviceVendor.upsert.mock.calls[0][0].update.baseCity).toBeUndefined();
  });

  it('registration resume: a pending partner may switch to a valid served city', async () => {
    const { service, prisma } = makeService({ existing: { id: 'v1', status: 'PENDING_VERIFICATION', skills: ['ELECTRICAL'], baseCity: 'Bhopal' } });
    await service.register('u1', { fullName: 'R', baseCity: 'indore', skills: ['ELECTRICAL'] });
    expect(prisma.serviceVendor.upsert.mock.calls[0][0].update.baseCity).toBe('Indore');
  });

  it('does not block onboarding when no categories/cities are configured', async () => {
    const { service } = makeService({ categories: [], cities: [] });
    await expect(service.register('u1', { fullName: 'R', baseCity: 'Anywhere', skills: ['Anything'] })).resolves.toBeDefined();
  });
});
