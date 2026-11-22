import { Module, Injectable, Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { Public } from '../../common';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { Prisma } from '@prisma/client';
import { detectIntent, Intent } from '../ai-agent/intent-engine';
import { discover, resolveCategorySlug, categoryUrlSlug, CategoryMatch } from './service-discovery';

// search()'s literal substring match (below) misses natural-language phrasing like
// "AC cooling nahi kar raha" or "naya ghar banana hai" — real ServiceCategory.key
// values it can fall back to per detected intent. Includes both the legacy
// UPPER_SNAKE keys the original catalog was seeded with and the newer lowercase
// keys some categories were later duplicated under (real, pre-existing DB state —
// not something this change introduces or cleans up).
const INTENT_TO_CATEGORY_KEYS: Partial<Record<Intent, string[]>> = {
  AC: ['AC_SERVICE'],
  PLUMBING: ['PLUMBING'],
  ELECTRICAL: ['ELECTRICAL'],
  APPLIANCE: ['APPLIANCE', 'appliance'],
  CLEANING: ['CLEANING'],
  INTERIOR: ['INTERIOR', 'interior'],
  RENOVATION: ['RENOVATION', 'renovation'],
  CONSTRUCTION: ['CONSTRUCTION', 'construction'],
};

// The parent listing a service belongs to (see CatalogVariantGroup) — lets the website show
// sibling rows as one card with options. Only the fields a customer page needs.
const VARIANT_GROUP_PUBLIC = { select: { id: true, name: true, optionNames: true, isActive: true, description: true, images: true } } as const;

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService, private cities: CitiesService) {}

  async listAll(categoryId?: string, city?: string) {
    const where: any = { isActive: true };
    if (categoryId) where.categoryId = categoryId;
    if (city) {
      const activeKeys = await this.cities.getActiveServicesForCity(city);
      where.category = { key: { in: activeKeys } };
    }
    return this.prisma.service.findMany({
      where,
      include: { category: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * List service categories with city-wise filtering.
   * If `city` is provided, services unavailable in that city
   * are returned with `_unavailable: true` (not hidden — frontend can
   * grey them out).
   */
  async listCategories(city?: string) {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        // Kept flat + unfiltered-by-subcategory for backward compatibility with anything
        // still reading category.services directly.
        services: { where: { isActive: true }, orderBy: { name: 'asc' }, include: { variantGroup: VARIANT_GROUP_PUBLIC } },
        subCategories: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          include: { services: { where: { isActive: true }, orderBy: { name: 'asc' }, include: { variantGroup: VARIANT_GROUP_PUBLIC } } },
        },
      },
    });

    if (!city) return categories;

    const activeKeys = await this.cities.getActiveServicesForCity(city);
    return categories.map((c) => ({
      ...c,
      _unavailable: !activeKeys.includes(c.key),
    }));
  }

  async getCategory(key: string) {
    const cat = await this.prisma.serviceCategory.findUnique({
      where: { key },
      include: { services: { where: { isActive: true } } },
    });
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  async getService(id: string, city?: string) {
    const svc = await this.prisma.service.findUnique({
      where: { id },
      include: { category: true, variantGroup: VARIANT_GROUP_PUBLIC },
    });
    if (!svc) throw new NotFoundException('Service not found');

    // City-wise pricing override
    if (city) {
      const cityPrice = await this.cities.getServicePrice(city, id);
      if (cityPrice !== null) {
        return { ...svc, basePrice: cityPrice, _cityPrice: true };
      }
    }
    return svc;
  }

  async listPopular(limit = 10) {
    return this.prisma.service.findMany({
      where: { isActive: true, isPopular: true },
      take: limit,
      include: { category: true },
    });
  }

  async listPremium() {
    return this.prisma.service.findMany({
      where: { isActive: true, isPremium: true },
      include: { category: true },
    });
  }

  /**
   * Services for a free-text query (REMI's search_services, the app's search). Goes through the
   * same discovery as the website ("Mujhe plumber chahiye" → Plumbing's services); a literal
   * name match is only the fallback for queries discovery cannot place.
   */
  async search(query: string) {
    query = String(query || '').trim();
    if (!query) return [];
    const d = await this.discover(query);
    if (d.services.length) return d.services;

    const literal = await this.prisma.service.findMany({
      where: { isActive: true, name: { contains: query.slice(0, 100), mode: 'insensitive' } },
      include: { category: true },
      take: 20,
    });
    if (literal.length) return literal;

    // Last resort: the coarse multilingual intent classifier the chat already uses.
    const { intent } = detectIntent(query);
    const categoryKeys = INTENT_TO_CATEGORY_KEYS[intent];
    if (!categoryKeys) return [];
    return this.prisma.service.findMany({
      where: { isActive: true, category: { key: { in: categoryKeys } } },
      include: { category: true },
      orderBy: [{ isPopular: 'desc' }, { name: 'asc' }],
      take: 20,
    });
  }

  // ── Service discovery (website search, voice, /services/<slug>, REMI, app) ──────────────
  // The active catalogue is small (a few hundred rows) and read on every search keystroke, so it
  // is cached briefly; admin changes show up within CATALOG_TTL_MS.
  private catalogCache: { at: number; data: Promise<DiscoveryCatalog> } | null = null;

  private loadCatalog(): Promise<DiscoveryCatalog> {
    const now = Date.now();
    if (this.catalogCache && now - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.data;
    const data = (async () => {
      const [categories, services] = await Promise.all([
        this.prisma.serviceCategory.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { ...CATEGORY_PUBLIC, subCategories: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, sortOrder: true } } },
        }),
        this.prisma.service.findMany({
          where: { isActive: true, category: { isActive: true } },
          orderBy: [{ isPopular: 'desc' }, { name: 'asc' }],
          select: SERVICE_PUBLIC,
        }),
      ]);
      return { categories, services };
    })();
    this.catalogCache = { at: now, data };
    data.catch(() => { if (this.catalogCache?.data === data) this.catalogCache = null; });
    return data;
  }

  private static discoveryInput(cat: DiscoveryCatalog) {
    const counts = new Map<string, number>();
    for (const s of cat.services) counts.set(s.categoryId, (counts.get(s.categoryId) || 0) + 1);
    const subName = new Map<string, string>();
    for (const c of cat.categories) for (const sc of c.subCategories) subName.set(sc.id, sc.name);
    return {
      categories: cat.categories.map((c) => ({ id: c.id, key: c.key, slug: c.slug, name: c.name, serviceCount: counts.get(c.id) || 0 })),
      services: cat.services.map((s) => ({ id: s.id, name: s.name, categoryId: s.categoryId, subCategoryName: s.subCategoryId ? subName.get(s.subCategoryId) : null, isPopular: s.isPopular })),
    };
  }

  /**
   * Free text (English / Hindi / Hinglish, typed or spoken) → the real category to open, the
   * matching real services with their prices, variants and images, and a confidence. When two
   * categories fit about equally (`ambiguous`), `best` is null and `categories` are the choices.
   */
  async discover(query: string) {
    const cat = await this.loadCatalog();
    const input = ServicesService.discoveryInput(cat);
    const r = discover(String(query || ''), input.categories, input.services);
    const catById = new Map(cat.categories.map((c) => [c.id, c]));
    const svcById = new Map(cat.services.map((s) => [s.id, s]));
    const card = (m: CategoryMatch) => {
      const c = catById.get(m.id)!;
      return { ...m, description: c.description, icon: c.icon, imageUrl: c.imageUrl || c.logoUrl || null };
    };
    const withCategory = (s: (typeof cat.services)[number]) => {
      const c = catById.get(s.categoryId);
      return { ...s, category: c ? { id: c.id, key: c.key, slug: categoryUrlSlug(c), name: c.name } : null };
    };
    let services = r.services.map((m) => svcById.get(m.id)).filter(Boolean).map((s) => withCategory(s!));
    // "Mujhe carpenter chahiye" names no particular service: show the category's own services.
    if (!services.length && r.best) services = cat.services.filter((s) => s.categoryId === r.best!.id).slice(0, 12).map(withCategory);
    return {
      query: r.query, normalized: r.normalized, ambiguous: r.ambiguous, confidence: r.confidence,
      best: r.best ? card(r.best) : null,
      categories: r.categories.map(card),
      services,
    };
  }

  /**
   * /services/<slug> page data: the category (by DB slug or key, or an alias such as "plumber" or
   * "ac-repair" resolved by the same discovery), its sub-categories and every active service with
   * prices, variants and the listing's common description/images. 404 for an unknown or
   * inactive category — the page shows "not found" instead of a wrong category.
   */
  async categoryPage(slugParam: string) {
    const cat = await this.loadCatalog();
    const input = ServicesService.discoveryInput(cat);
    const hit = resolveCategorySlug(slugParam, input.categories, input.services);
    if (!hit) throw new NotFoundException('Category not found');
    const c = cat.categories.find((x) => x.id === hit.category.id)!;
    const services = cat.services.filter((s) => s.categoryId === c.id);
    return {
      category: { ...c, subCategories: c.subCategories.filter((sc) => services.some((s) => s.subCategoryId === sc.id)) },
      canonicalSlug: categoryUrlSlug(c),
      matchedBy: hit.matchedBy,
      services,
    };
  }
}

// Fields a public category/service page needs — never internal pricing/commission columns.
const CATEGORY_PUBLIC = {
  id: true, key: true, slug: true, name: true, icon: true, logoUrl: true, imageUrl: true, description: true,
  seoTitle: true, seoDesc: true, seoKeywords: true, sortOrder: true,
} as const;
const SERVICE_PUBLIC = {
  id: true, name: true, slug: true, description: true, unit: true, inclusions: true, exclusions: true,
  basePrice: true, originalPrice: true, durationMinutes: true, imageUrl: true, images: true, pricingType: true,
  isPopular: true, isPremium: true, categoryId: true, subCategoryId: true,
  variantGroupId: true, variantOptions: true, variantSortOrder: true, variantGroup: VARIANT_GROUP_PUBLIC,
} as const;
const CATALOG_TTL_MS = 60_000;
type DiscoveryCatalog = {
  categories: Array<Prisma.ServiceCategoryGetPayload<{ select: typeof CATEGORY_PUBLIC & { subCategories: { select: { id: true; name: true; sortOrder: true } } } }>>;
  services: Array<Prisma.ServiceGetPayload<{ select: typeof SERVICE_PUBLIC }>>;
};

@ApiTags('Services')
@Public()
@Controller('services')
export class ServicesController {
  constructor(private svc: ServicesService) {}

  @Get()
  list(@Query('categoryId') categoryId?: string, @Query('city') city?: string) {
    return this.svc.listAll(categoryId, city);
  }

  @Get('categories')
  categories(@Query('city') city?: string) { return this.svc.listCategories(city); }

  @Get('categories/:key')
  category(@Param('key') key: string) { return this.svc.getCategory(key); }

  @Get('popular')
  popular() { return this.svc.listPopular(); }

  @Get('premium')
  premium() { return this.svc.listPremium(); }

  @Get('search')
  search(@Query('q') q: string) { return this.svc.search(q || ''); }

  // One resolver for website search, voice, REMI and the app — see service-discovery.ts.
  @Get('discover')
  discover(@Query('q') q?: string) { return this.svc.discover(String(q || '').slice(0, 200)); }

  @Get('category-page/:slug')
  categoryPage(@Param('slug') slug: string) { return this.svc.categoryPage(slug); }

  @Get(':id')
  one(@Param('id') id: string, @Query('city') city?: string) {
    return this.svc.getService(id, city);
  }
}

@Module({
  imports: [CitiesModule],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
