import { ServicesService } from './services.module';

// Catalogue rows as the discovery cache loads them (serviceCategory.findMany + service.findMany).
const CATS = [
  { id: 'c-ac', key: 'AC_SERVICE', slug: 'ac-service-repair', name: 'AC Service & Repair', icon: '❄️', subCategories: [] },
  { id: 'c-pl', key: 'PLUMBING', slug: 'plumbing', name: 'Plumbing', icon: '🔧', subCategories: [{ id: 'sc-tap', name: 'Tap & Faucet', sortOrder: 0 }] },
  { id: 'c-ca', key: 'CARPENTRY', slug: 'carpentry-woodwork', name: 'Carpentry & Woodwork', icon: '🪚', subCategories: [] },
  { id: 'c-in', key: 'interior', slug: null, name: 'Interior Design', icon: '🏠', subCategories: [] },
  // No active service yet — must not exist for customers.
  { id: 'c-fc', key: 'FALSE-CEILING', slug: 'false-ceiling', name: 'False Ceiling', icon: '🏠', subCategories: [] },
];
const SVCS = [
  { id: 's1', name: 'AC Servicing (Split)', categoryId: 'c-ac', subCategoryId: null, isPopular: true, basePrice: 499 },
  { id: 's2', name: 'AC Gas Filling (R32)', categoryId: 'c-ac', subCategoryId: null, isPopular: false, basePrice: 2500 },
  { id: 's3', name: 'Tap Repair (Leak/Drip Fix)', categoryId: 'c-pl', subCategoryId: 'sc-tap', isPopular: false, basePrice: 199 },
  { id: 's4', name: 'Emergency Plumber Visit', categoryId: 'c-pl', subCategoryId: null, isPopular: true, basePrice: 299 },
  { id: 's5', name: 'Door Lock Repair', categoryId: 'c-ca', subCategoryId: null, isPopular: false, basePrice: 249 },
  { id: 's6', name: 'Full Home Interior Design', categoryId: 'c-in', subCategoryId: null, isPopular: false, basePrice: 0 },
];

function makePrisma(literal: any[] = [], fallback: any[] = []) {
  const extra: any[] = [];
  return {
    extra,
    serviceCategory: { findMany: jest.fn(async () => CATS) },
    service: {
      findMany: jest.fn(async (args: any) => {
        if (args.select) return SVCS; // the discovery catalogue
        extra.push(args);
        return extra.length === 1 ? literal : fallback;
      }),
    },
  };
}

describe('ServicesService.search() — the same discovery as the website, then literal / intent fallbacks', () => {
  it('"Mujhe plumber chahiye" → the Plumbing services (no literal name match needed)', async () => {
    const prisma = makePrisma();
    const out: any[] = await new ServicesService(prisma as any, {} as any).search('Mujhe plumber chahiye');
    expect(out.map((s) => s.id)).toEqual(expect.arrayContaining(['s4']));
    expect(out.every((s) => s.category.key === 'PLUMBING')).toBe(true);
    expect(prisma.extra).toHaveLength(0);
  });

  it('"AC servicing karwani hai" → the AC servicing row first, with its real price', async () => {
    const out: any[] = await new ServicesService(makePrisma() as any, {} as any).search('AC servicing karwani hai');
    expect(out[0]).toMatchObject({ id: 's1', basePrice: 499, category: { key: 'AC_SERVICE', slug: 'ac-service-repair' } });
  });

  it('"Mujhe carpenter chahiye" names no service → the category\'s own services', async () => {
    const out: any[] = await new ServicesService(makePrisma() as any, {} as any).search('Mujhe carpenter chahiye');
    expect(out.map((s) => s.id)).toEqual(['s5']);
  });

  it('falls back to a literal name match for queries discovery cannot place', async () => {
    const prisma = makePrisma([{ id: 'x1', name: 'Zebra Blinds' }]);
    const out = await new ServicesService(prisma as any, {} as any).search('zebra blinds');
    expect(out).toEqual([{ id: 'x1', name: 'Zebra Blinds' }]);
    expect(prisma.extra[0].where.name.contains).toBe('zebra blinds');
    expect(prisma.extra[0].where.description).toBeUndefined(); // descriptions no longer drag in noise
  });

  it('unknown gibberish returns empty rather than guessing', async () => {
    const prisma = makePrisma([], []);
    expect(await new ServicesService(prisma as any, {} as any).search('asdkjaslkdj random gibberish')).toEqual([]);
  });

  it('the catalogue is loaded once and reused across searches (cached)', async () => {
    const prisma = makePrisma();
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('plumber');
    await svc.discover('electrician');
    await svc.categoryPage('plumber');
    expect(prisma.serviceCategory.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('ServicesService.categoryPage() — /services/<slug>', () => {
  it('resolves aliases to the real category with all its services', async () => {
    const page: any = await new ServicesService(makePrisma() as any, {} as any).categoryPage('plumber');
    expect(page.category.key).toBe('PLUMBING');
    expect(page.canonicalSlug).toBe('plumbing');
    expect(page.matchedBy).toBe('alias');
    expect(page.services.map((s: any) => s.id).sort()).toEqual(['s3', 's4']);
    expect(page.category.subCategories).toEqual([{ id: 'sc-tap', name: 'Tap & Faucet', sortOrder: 0 }]);
  });

  it('a category without a slug gets its key as the canonical slug', async () => {
    const page: any = await new ServicesService(makePrisma() as any, {} as any).categoryPage('interior');
    expect(page.canonicalSlug).toBe('interior');
  });

  it('a category with no active service is hidden: 404 page, never a search result', async () => {
    const svc = new ServicesService(makePrisma() as any, {} as any);
    await expect(svc.categoryPage('false-ceiling')).rejects.toThrow('Category not found');
    const d: any = await svc.discover('false ceiling');
    expect(d.categories.map((c: any) => c.key)).not.toContain('FALSE-CEILING');
  });

  it('unknown slug → 404', async () => {
    await expect(new ServicesService(makePrisma() as any, {} as any).categoryPage('no-such-thing')).rejects.toThrow('Category not found');
  });
});
