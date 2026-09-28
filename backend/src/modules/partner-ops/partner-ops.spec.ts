import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PartnerOpsKeyGuard, PartnerOpsService } from './partner-ops.module';

function makeService(data: {
  vendors?: any[]; applications?: any[]; categories?: any[]; sellers?: any[]; sellerApplications?: any[];
}) {
  const prisma: any = {
    serviceVendor: { findMany: jest.fn().mockResolvedValue(data.vendors ?? []) },
    partnerRegistration: { findMany: jest.fn().mockResolvedValue(data.applications ?? []) },
    serviceCategory: { findMany: jest.fn().mockResolvedValue(data.categories ?? []) },
    productVendor: { findMany: jest.fn().mockResolvedValue(data.sellers ?? []) },
    sellerRegistration: { findMany: jest.fn().mockResolvedValue(data.sellerApplications ?? []) },
  };
  return { service: new PartnerOpsService(prisma), prisma };
}

const CATEGORIES = [
  { key: 'ELECTRICAL', name: 'Electrician' },
  { key: 'PLUMBING', name: 'Plumber' },
  { key: 'AC_REPAIR', name: 'AC Repair' },
];

describe('PartnerOpsService.summary', () => {
  it('counts onboarding / onboarded / live / offline / inactive from real status fields', async () => {
    const { service } = makeService({
      categories: CATEGORIES,
      vendors: [
        { status: 'ACTIVE', isOnline: true, baseCity: 'Indore', skills: ['ELECTRICIAN'], user: { phone: '+919000000001' } },
        { status: 'ACTIVE', isOnline: false, baseCity: 'Indore', skills: ['electrician', 'PLUMBER'], user: { phone: '+919000000002' } },
        { status: 'ACTIVE', isOnline: true, baseCity: 'Bhopal', skills: ['PLUMBER'], user: { phone: '+919000000003' } },
        { status: 'SUSPENDED', isOnline: false, baseCity: 'Bhopal', skills: ['AC_REPAIR'], user: { phone: '+919000000004' } },
        { status: 'PENDING_VERIFICATION', isOnline: false, baseCity: 'indore ', skills: [], user: { phone: '+919000000005' } },
      ],
      applications: [
        { phone: '9000000006', city: 'Jabalpur', categories: ['AC_REPAIR'] },
        // same person as an existing vendor -> not double counted
        { phone: '+91 90000 00001', city: 'Indore', categories: ['ELECTRICIAN'] },
        { phone: '9000000007', city: null, categories: ['SOME_SUBCATEGORY'] },
      ],
    });

    const out = await service.summary();

    expect(out.partners.summary).toEqual({ onboarding: 3, onboarded: 3, live: 2, offline: 1, inactive: 1 });

    const indore = out.partners.cities.find((c: any) => c.city === 'Indore')!;
    expect(indore).toMatchObject({ onboarding: 1, onboarded: 2, live: 1, offline: 1, inactive: 0 });
    expect(out.partners.cities.map((c: any) => c.city)).toEqual(expect.arrayContaining(['Indore', 'Bhopal', 'Jabalpur', 'Not set']));
    expect(out.partners.cities).toHaveLength(4);        // "indore " and "Indore" are one city

    const elec = out.partners.categories.find((c: any) => c.key === 'ELECTRICAL')!;
    expect(elec).toMatchObject({ category: 'Electrician', live: 1, offline: 1, onboarded: 2 });
    const plumber = out.partners.categories.find((c: any) => c.key === 'PLUMBING')!;
    expect(plumber).toMatchObject({ live: 1, offline: 1, onboarded: 2 });
    // unknown keys are never presented as categories
    expect(out.partners.categories.map((c: any) => c.key)).not.toContain('SOME_SUBCATEGORY');

    // city x category detail
    const indoreElec = indore.categories!.find((c: any) => c.key === 'ELECTRICAL');
    expect(indoreElec).toMatchObject({ live: 1, offline: 1 });

    expect(out.truncated).toBe(false);
    expect(typeof out.generated_at).toBe('string');
  });

  it('never returns personal data (names, phones, ids, documents)', async () => {
    const { service } = makeService({
      categories: CATEGORIES,
      vendors: [{ status: 'ACTIVE', isOnline: true, baseCity: 'Indore', skills: ['ELECTRICIAN'], user: { phone: '+919876543210' } }],
      applications: [{ phone: '9123456789', city: 'Indore', categories: [] }],
      sellers: [{ status: 'ACTIVE', isOpen: true, city: 'Indore', user: { phone: '+919111111111' } }],
    });
    const json = JSON.stringify(await service.summary());
    for (const secret of ['9876543210', '9123456789', '9111111111']) expect(json).not.toContain(secret);
  });

  it('selects only aggregate-safe columns from the database', async () => {
    const { service, prisma } = makeService({});
    await service.summary();
    const vendorSelect = prisma.serviceVendor.findMany.mock.calls[0][0].select;
    expect(Object.keys(vendorSelect).sort()).toEqual(['baseCity', 'isOnline', 'skills', 'status', 'user']);
    expect(vendorSelect.user).toEqual({ select: { phone: true } });    // only for de-duplication
    const appSelect = prisma.partnerRegistration.findMany.mock.calls[0][0].select;
    expect(Object.keys(appSelect).sort()).toEqual(['categories', 'city', 'phone']);
    // rejected / approved applications are not "onboarding"
    expect(prisma.partnerRegistration.findMany.mock.calls[0][0].where.status.in).toEqual(['PENDING', 'HOLD', 'MORE_DOCS']);
  });

  it('counts sellers with the same status rules (isOpen is the seller online toggle)', async () => {
    const { service } = makeService({
      sellers: [
        { status: 'ACTIVE', isOpen: true, city: 'Indore', user: { phone: '9000000011' } },
        { status: 'ACTIVE', isOpen: false, city: 'Indore', user: { phone: '9000000012' } },
        { status: 'SUSPENDED', isOpen: false, city: 'Pune', user: { phone: '9000000013' } },
      ],
      sellerApplications: [{ phone: '9000000014', city: 'Pune' }, { phone: '9000000011', city: 'Indore' }],
    });
    const out = await service.summary();
    expect(out.sellers.summary).toEqual({ onboarding: 1, onboarded: 2, live: 1, offline: 1, inactive: 1 });
    expect((out.sellers as any).categories).toBeUndefined();
  });

  it('returns empty lists (not invented rows) when there is no data', async () => {
    const { service } = makeService({ categories: CATEGORIES });
    const out = await service.summary();
    expect(out.partners.summary).toEqual({ onboarding: 0, onboarded: 0, live: 0, offline: 0, inactive: 0 });
    expect(out.partners.cities).toEqual([]);
    expect(out.partners.categories).toEqual([]);
  });
});

describe('PartnerOpsKeyGuard', () => {
  const KEY = 'k'.repeat(40);
  const ctx = (headers: Record<string, string>) => ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as any;
  const saved = process.env.PARTNER_OPS_API_KEY;
  afterEach(() => { process.env.PARTNER_OPS_API_KEY = saved; });

  it('fails closed when the key is not configured', () => {
    delete process.env.PARTNER_OPS_API_KEY;
    expect(() => new PartnerOpsKeyGuard().canActivate(ctx({ 'x-api-key': KEY }))).toThrow(ServiceUnavailableException);
  });

  it('refuses a missing or wrong key and accepts the right one', () => {
    process.env.PARTNER_OPS_API_KEY = KEY;
    const g = new PartnerOpsKeyGuard();
    expect(() => g.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(() => g.canActivate(ctx({ 'x-api-key': 'wrong' }))).toThrow(UnauthorizedException);
    expect(g.canActivate(ctx({ 'x-api-key': KEY }))).toBe(true);
  });
});
