import { Module, Injectable, Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { Public } from '../../common';
import { CitiesService, CitiesModule } from '../cities/cities.module';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService, private cities: CitiesService) {}

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
      include: { services: { where: { isActive: true }, orderBy: { name: 'asc' } } },
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
    return this.prisma.service.findMany({
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
  }
}

@ApiTags('Services')
@Public()
@Controller('services')
export class ServicesController {
  constructor(private svc: ServicesService) {}

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
