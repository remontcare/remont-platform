import { discover, resolveCategorySlug, normalizeQuery, DiscoveryCategory, DiscoveryService } from './service-discovery';

// A snapshot of the REAL public catalogue (GET /api/v1/services/categories, 2026-11-22): every
// active category with its real key/slug/name and every active service name. The resolver is
// tested against what customers actually search, on the data they actually see.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx = require('./__fixtures__/live-catalog.json');
const cats: DiscoveryCategory[] = fx.categories.map((c: any) => ({ id: c.id, key: c.key, slug: c.slug, name: c.name, serviceCount: c.services.length }));
const svcs: DiscoveryService[] = fx.categories.flatMap((c: any) => c.services.map((s: any) => ({ id: s.id, name: s.name, categoryId: c.id, subCategoryName: s.sub })));
const keyOf = (id?: string | null) => cats.find((c) => c.id === id)?.key;
const svcName = (id: string) => svcs.find((s) => s.id === id)!.name;

const cases: Array<[string, string]> = [
  // The owner's examples — English, Hinglish, Hindi
  ['I need a plumber', 'PLUMBING'],
  ['Mujhe plumber chahiye', 'PLUMBING'],
  ['I need an electrician', 'ELECTRICAL'],
  ['Mujhe electrician chahiye', 'ELECTRICAL'],
  ['Mujhe AC technician chahiye', 'AC_SERVICE'],
  ['AC servicing karwani hai', 'AC_SERVICE'],
  ['Bathroom renovation karwana hai', 'RENOVATION'],
  ['Need deep home cleaning', 'CLEANING'],
  ['Mujhe carpenter chahiye', 'CARPENTRY'],
  ['मुझे प्लंबर चाहिए', 'PLUMBING'],
  ['मुझे इलेक्ट्रीशियन चाहिए', 'ELECTRICAL'],
  ['बढ़ई चाहिए', 'CARPENTRY'],
  ['एसी सर्विस', 'AC_SERVICE'],
  // Misspellings (typed and mis-heard by voice)
  ['plumbr', 'PLUMBING'], ['plumbar chahiye', 'PLUMBING'], ['electritian', 'ELECTRICAL'], ['electrision', 'ELECTRICAL'],
  ['carpanter', 'CARPENTRY'], ['clening', 'CLEANING'], ['waterprofing', 'WATERPROOFING'], ['renovaton', 'RENOVATION'],
  // Problems described, not trades named
  ['ac not cooling', 'AC_SERVICE'], ['AC thanda nahi kar raha', 'AC_SERVICE'], ['tap leaking', 'PLUMBING'],
  ['nal tapak raha hai', 'PLUMBING'], ['toilet blocked', 'PLUMBING'], ['drain jam ho gaya', 'PLUMBING'],
  ['fan install karna hai', 'ELECTRICAL'], ['switch board kharab hai', 'ELECTRICAL'], ['mcb trip ho raha hai', 'ELECTRICAL'],
  ['bijli ka kaam', 'ELECTRICAL'], ['washing machine repair', 'APPLIANCE'], ['fridge not cooling', 'APPLIANCE'],
  ['geyser repair', 'APPLIANCE'], ['RO service', 'APPLIANCE'], ['cockroach problem', 'PEST_CONTROL'],
  ['deemak lag gayi', 'PEST_CONTROL'], ['termite treatment', 'PEST_CONTROL'], ['khatmal', 'PEST_CONTROL'],
  ['pest control', 'PEST_CONTROL'], ['wall painting', 'PAINTING'], ['ghar ka rang karwana hai', 'PAINTING'],
  ['painter', 'PAINTING'], ['door repair', 'CARPENTRY'], ['darwaza theek karna hai', 'CARPENTRY'],
  ['almari banwani hai', 'CARPENTRY'], ['kitchen renovation', 'RENOVATION'], ['naya ghar banana hai', 'CONSTRUCTION'],
  ['house construction', 'CONSTRUCTION'], ['contractor chahiye', 'CONSTRUCTION'], ['chhat se paani tapak raha hai', 'WATERPROOFING'],
  ['seelan', 'WATERPROOFING'], ['waterproofing', 'WATERPROOFING'], ['interior designer', 'INTERIOR'],
  ['sofa cleaning', 'CLEANING'], ['bathroom cleaning', 'CLEANING'], ['AC deep cleaning', 'AC_SERVICE'],
  ['AC gas filling', 'AC_SERVICE'], ['split ac installation', 'AC_SERVICE'], ['tile', 'RENOVATION'],
  ['A.C. repair', 'AC_SERVICE'], ['PLUMBER!!!', 'PLUMBING'],
];

describe('service discovery — real catalogue, English / Hindi / Hinglish / typos', () => {
  it.each(cases)('"%s" → %s', (q, key) => {
    const r = discover(q, cats, svcs);
    expect(r.ambiguous).toBe(false);
    expect(keyOf(r.best?.id)).toBe(key);
    expect(r.best!.url).toBe(`/services/${cats.find((c) => c.key === key)!.slug}`);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('"Ghar mein paani leak ho raha hai" → Plumbing, with Waterproofing offered as the alternative', () => {
    for (const q of ['Ghar mein paani leak ho raha hai', 'पानी लीक हो रहा है']) {
      const r = discover(q, cats, svcs);
      expect(keyOf(r.best?.id)).toBe('PLUMBING');
      expect(r.categories.map((c) => c.key)).toContain('WATERPROOFING');
    }
  });

  it('ambiguous queries return choices instead of guessing one', () => {
    const r = discover('false ceiling', cats, svcs);
    expect(r.ambiguous).toBe(true);
    expect(r.best).toBeNull();
    expect(r.categories.map((c) => c.key)).toEqual(expect.arrayContaining(['FALSE-CEILING', 'ELECTRICAL']));
  });

  it('services matching the words rank first ("AC servicing" → the servicing rows, "AC gas filling" → gas rows)', () => {
    expect(svcName(discover('AC servicing karwani hai', cats, svcs).services[0].id)).toMatch(/servic/i);
    expect(svcName(discover('AC gas filling', cats, svcs).services[0].id)).toMatch(/gas/i);
    expect(svcName(discover('Bathroom renovation karwana hai', cats, svcs).services[0].id)).toMatch(/bathroom renovation/i);
    // and they all belong to the chosen category
    const r = discover('tap leaking', cats, svcs);
    expect(r.services.every((s) => s.categoryId === r.best!.id)).toBe(true);
  });

  it('nothing meaningful → no category (never a made-up match)', () => {
    for (const q of ['', '   ', 'hello', 'best service', 'repair', 'xyzzy', 'mujhe chahiye', '!!!']) {
      const r = discover(q, cats, svcs);
      expect(r.best).toBeNull();
      expect(r.categories).toEqual([]);
      expect(r.services).toEqual([]);
    }
  });

  it('only categories from the catalogue passed in are ever returned', () => {
    const onlyPest = cats.filter((c) => c.key === 'PEST_CONTROL');
    const r = discover('I need a plumber', onlyPest, svcs.filter((s) => s.categoryId === onlyPest[0].id));
    expect(r.best).toBeNull();
    expect(r.categories).toEqual([]);
  });

  it('normalises Devanagari and strips fillers', () => {
    expect(normalizeQuery('मुझे प्लंबर चाहिए')).toEqual(['plumber']);
    expect(normalizeQuery('I need an Electrician please')).toEqual(['electrician']);
    expect(normalizeQuery('a.c. service')).toEqual(['ac', 'service']);
  });
});

describe('resolveCategorySlug — /services/<slug>', () => {
  it.each([
    ['plumber', 'PLUMBING', 'alias'], ['plumbing', 'PLUMBING', 'slug'], ['electrician', 'ELECTRICAL', 'alias'],
    ['electrical-work', 'ELECTRICAL', 'alias'], ['ac-repair', 'AC_SERVICE', 'alias'], ['carpenter', 'CARPENTRY', 'alias'],
    ['cleaning', 'CLEANING', 'key'], ['waterproofing', 'WATERPROOFING', 'slug'], ['pest-control', 'PEST_CONTROL', 'slug'],
    ['home-cleaning', 'CLEANING', 'slug'], ['ac-service-repair', 'AC_SERVICE', 'slug'], ['AC_SERVICE', 'AC_SERVICE', 'key'],
    ['appliance-repair', 'APPLIANCE', 'slug'], ['interior-design', 'INTERIOR', 'slug'], ['painting', 'PAINTING', 'key'],
    ['carpentry-woodwork', 'CARPENTRY', 'slug'], ['Plumber', 'PLUMBING', 'alias'], ['electrician%20', 'ELECTRICAL', 'alias'],
  ])('%s → %s (%s)', (slug, key, how) => {
    const r = resolveCategorySlug(slug, cats, svcs);
    expect(r?.category.key).toBe(key);
    expect(r?.matchedBy).toBe(how);
  });

  it('unknown slugs are not found (no wrong page)', () => {
    for (const s of ['nonsense-page', 'services', '', 'hello', '%E0%A4', 'x'.repeat(300)]) expect(resolveCategorySlug(s, cats, svcs)).toBeNull();
  });

  it('a duplicate category key/name never wins over the real one with services', () => {
    // "construction" is both the slug of CONSTRUCTION (37 services) and the key of an empty
    // duplicate "Civil Construction" — the slug match with services wins.
    expect(resolveCategorySlug('construction', cats, svcs)?.category.key).toBe('CONSTRUCTION');
    expect(resolveCategorySlug('interior', cats, svcs)?.category.key).toBe('INTERIOR');
  });
});
