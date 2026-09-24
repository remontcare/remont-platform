import { ServiceUnavailableException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { AiCatalogKeyGuard, AiCatalogService } from './ai-catalog.module';

const KEY = 'test-ai-catalog-key-0123456789abcdef0123'; // not a real secret

function ctxWith(headers: Record<string, string>) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any;
}

describe('AiCatalogKeyGuard', () => {
  const OLD = process.env.AI_CATALOG_API_KEY;
  afterEach(() => { process.env.AI_CATALOG_API_KEY = OLD; });

  it('fails closed when the server has no key configured', () => {
    delete process.env.AI_CATALOG_API_KEY;
    expect(() => new AiCatalogKeyGuard().canActivate(ctxWith({ 'x-ai-catalog-key': 'anything' })))
      .toThrow(ServiceUnavailableException);
  });

  it('refuses a short (weak) configured key', () => {
    process.env.AI_CATALOG_API_KEY = 'short';
    expect(() => new AiCatalogKeyGuard().canActivate(ctxWith({ 'x-ai-catalog-key': 'short' })))
      .toThrow(ServiceUnavailableException);
  });

  it('rejects a missing or wrong key', () => {
    process.env.AI_CATALOG_API_KEY = KEY;
    expect(() => new AiCatalogKeyGuard().canActivate(ctxWith({}))).toThrow(UnauthorizedException);
    expect(() => new AiCatalogKeyGuard().canActivate(ctxWith({ 'x-ai-catalog-key': KEY + 'x' })))
      .toThrow(UnauthorizedException);
  });

  it('accepts the exact key', () => {
    process.env.AI_CATALOG_API_KEY = KEY;
    expect(new AiCatalogKeyGuard().canActivate(ctxWith({ 'x-ai-catalog-key': KEY }))).toBe(true);
  });
});

function makeService(over: Partial<Record<string, any>> = {}) {
  const prisma = {
    serviceCategory: { findMany: jest.fn(async () => [{ key: 'AC_SERVICE', name: 'AC', description: null, subCategories: [] }]) },
    service: { findFirst: jest.fn(async (_args: any) => over.serviceRow ?? null) },
    city: { findMany: jest.fn(async () => [{ name: 'Bhopal' }, { name: 'Vadodara' }]) },
  };
  const services = { search: jest.fn(async () => over.searchRows ?? []) };
  const cities = {
    checkServiceability: jest.fn(async (pin: string) => (pin === '462001' ? { serviceable: true, city: { name: 'Bhopal' } } : { serviceable: false, city: null })),
    getByName: jest.fn(async (n: string) => (n === 'Bhopal' ? { name: 'Bhopal', isActive: true, activeServiceKeys: ['AC_SERVICE'] } : null)),
  };
  const estimates = { estimate: jest.fn(async () => over.estimate) };
  const cms = {
    getSettings: jest.fn(async () => ({ site_name: 'Remont India', support_phone: '+91 1', razorpay_key_secret: 'MUST-NOT-LEAK' })),
    getFaqs: jest.fn(async () => over.faqs ?? []),
  };
  const amc = { listPlans: jest.fn(async () => over.plans ?? []) };
  const svc = new AiCatalogService(prisma as any, services as any, cities as any, estimates as any, cms as any, amc as any);
  return { svc, prisma, services, estimates };
}

describe('AiCatalogService — minimal, safe responses', () => {
  it('search reuses the website search and returns no prices or costs', async () => {
    const { svc, services } = makeService({ searchRows: [{
      id: 'svc1', name: 'AC Service', category: { key: 'AC_SERVICE', name: 'AC' }, unit: 'per visit',
      pricingType: 'FIXED', durationMinutes: 60, isPopular: true,
      basePrice: 499, labourCost: 100, materialCost: 50, hsnSac: '9987',
    }] });
    const out = await svc.search('ac kharab hai', 5);
    expect(services.search).toHaveBeenCalledWith('ac kharab hai');
    expect(out).toEqual([{ id: 'svc1', name: 'AC Service', category: { key: 'AC_SERVICE', name: 'AC' },
      unit: 'per visit', pricingType: 'FIXED', durationMinutes: 60, isPopular: true }]);
    expect(JSON.stringify(out)).not.toMatch(/basePrice|labourCost|materialCost|hsnSac/);
  });

  it('service detail selects only customer-facing fields', async () => {
    const { svc, prisma } = makeService({ serviceRow: {
      id: 'svc1abcdefgh', name: 'AC Service', faqJson: [{ q: 'Warranty?', a: '30 days' }],
    } });
    const out: any = await svc.service('svc1abcdefgh');
    const select = (prisma.service.findFirst.mock.calls[0] as any[])[0].select;
    for (const secret of ['basePrice', 'labourCost', 'materialCost', 'gstOverridePercent', 'hsnSac', 'commissionRules']) {
      expect(select[secret]).toBeUndefined();
    }
    expect(out.faqs).toEqual([{ question: 'Warranty?', answer: '30 days' }]);
  });

  it('unknown or malformed service ids are 404/400, not a query for anything', async () => {
    const { svc } = makeService();
    await expect(svc.service('svc1abcdefgh')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.service("x' OR 1=1")).rejects.toThrow();
  });

  it('price is the website estimate engine result, without internal costs', async () => {
    const { svc, estimates } = makeService({ estimate: {
      service: { id: 'svc1abcdefgh', name: 'AC Service', pricingType: 'FIXED' },
      estimatedCost: { low: 499, high: 499, currency: 'INR' },
      breakdown: { labourCost: 100, materialCost: 50, consultationFee: 0, siteVisitFee: 0, gstPercent: 18 },
      finalPayableAmount: 588.82, requiresQuotation: false, timeline: { label: null },
      bookingEligibility: { eligible: true, message: null },
    } });
    const out: any = await svc.price({ serviceId: 'svc1abcdefgh', city: 'Bhopal' } as any);
    expect(estimates.estimate).toHaveBeenCalledWith({ serviceId: 'svc1abcdefgh', city: 'Bhopal', sqft: undefined });
    expect(out).toMatchObject({ serviceName: 'AC Service', estimatedLow: 499, estimatedHigh: 499,
      finalPayableAmount: 588.82, gstPercent: 18, requiresQuotation: false, bookingEligible: true });
    expect(JSON.stringify(out)).not.toMatch(/labourCost|materialCost/);
  });

  it('a quotation-only service returns no price at all', async () => {
    const { svc } = makeService({ estimate: {
      service: { id: 'svc2abcdefgh', name: 'Renovation', pricingType: 'QUOTATION' },
      estimatedCost: null, breakdown: { consultationFee: 0, siteVisitFee: 0, gstPercent: 18 },
      finalPayableAmount: 0, requiresQuotation: true, timeline: { label: '2–4 weeks' },
      bookingEligibility: { eligible: true, message: null },
    } });
    const out: any = await svc.price({ serviceId: 'svc2abcdefgh' } as any);
    expect(out).toMatchObject({ requiresQuotation: true, estimatedLow: null, estimatedHigh: null, timeline: '2–4 weeks' });
  });

  it('service area by pincode, by city, and the list of active cities', async () => {
    const { svc } = makeService();
    expect(await svc.serviceArea({ pincode: '462001' })).toMatchObject({ serviceable: true, city: 'Bhopal' });
    expect(await svc.serviceArea({ pincode: '560001' })).toMatchObject({ serviceable: false });
    expect(await svc.serviceArea({ city: 'Bhopal' })).toMatchObject({ serviceable: true, activeCategoryKeys: ['AC_SERVICE'] });
    expect(await svc.serviceArea({ city: 'Pune' })).toMatchObject({ serviceable: false });
    expect(await svc.serviceArea({})).toMatchObject({ serviceable: null, activeCities: ['Bhopal', 'Vadodara'] });
  });

  it('business info exposes only named public fields', async () => {
    const { svc } = makeService();
    const out = await svc.businessInfo();
    expect(out.name).toBe('Remont India');
    expect(JSON.stringify(out)).not.toContain('MUST-NOT-LEAK');
  });

  it('faqs are filtered by the query and capped', async () => {
    const faqs = [
      { question: 'Do you give warranty?', answer: '30 days', category: 'general' },
      { question: 'Payment methods?', answer: 'UPI, cards', category: 'payment' },
    ];
    const { svc } = makeService({ faqs });
    expect((await svc.faqs('warranty kitni hai')).map((f) => f.question)).toEqual(['Do you give warranty?']);
    expect(await svc.faqs()).toHaveLength(2);
  });

  it('amc plans map to numbers and published fields only', async () => {
    const { svc } = makeService({ plans: [{ id: 'p1', type: 'BASIC', name: 'Basic', description: null,
      durationMonths: 12, priceYearly: '1999.00', priceMonthly: null, includedServices: ['AC'],
      freeServicesCount: 2, discountPercent: 10, prioritySupport: false, benefitsJson: { internal: 1 } }] });
    const [plan]: any = await svc.amcPlans('Bhopal');
    expect(plan.priceYearly).toBe(1999);
    expect(plan.benefitsJson).toBeUndefined();
  });
});
