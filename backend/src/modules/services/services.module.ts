import { Module, Injectable, Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { Public } from '../../common';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { detectIntent, Intent } from '../ai-agent/intent-engine';

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
        services: { where: { isActive: true }, orderBy: { name: 'asc' } },
        subCategories: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          include: { services: { where: { isActive: true }, orderBy: { name: 'asc' } } },
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
      include: { category: true },
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

  async search(query: string) {
    if (!query) return [];
    const literal = await this.prisma.service.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: { category: true },
      take: 20,
    });
    if (literal.length) return literal;

    // Literal substring match found nothing — natural-language queries like "AC
    // cooling nahi kar raha" or "naya ghar banana hai" don't appear verbatim in
    // any service name/description. Fall back to the same multilingual keyword
    // classifier the AI chat already uses (detectIntent), mapped to the matching
    // real category — reuses existing categorization instead of a second catalog.
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
}

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
