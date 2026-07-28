import { Module, Injectable, Controller, Get, Query, Param, UseGuards, Post, Patch, Body } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public } from '../../common';

@Injectable()
export class CitiesService {
  constructor(private prisma: PrismaService) {}

  async list() {
    return this.prisma.city.findMany({
      where: { isActive: true },
      orderBy: [{ activeVendors: 'desc' }, { name: 'asc' }],
    });
  }

  async getByName(name: string) {
    return this.prisma.city.findUnique({ where: { name } });
  }

  async getActiveServicesForCity(cityName: string): Promise<string[]> {
    const city = await this.prisma.city.findUnique({
      where: { name: cityName },
      include: { services: { where: { isActive: true }, include: { service: { include: { category: true } } } } },
    });
    if (!city) return [];
    return city.services.map((cs) => cs.service.category.key);
  }

  async checkServiceability(pincode: string) {
    const city = await this.prisma.city.findFirst({
      where: { pincodes: { has: pincode }, isActive: true },
    });
    return { serviceable: !!city, city };
  }

  /**
   * Resolve a service's real price for one city: per-service CityService override
   * (if any) → else the city's blanket priceMultiplier on basePrice → else basePrice
   * as-is. Previously this returned null (leaving callers to fall back to the
   * unmultiplied basePrice) whenever no CityService row existed at all — meaning the
   * multiplier only ever applied to services an admin had explicitly configured for
   * that city, when it's meant to be the city-wide default and CityService rows are
   * only for the services that need a specific override.
   */
  async getServicePrice(cityName: string, serviceId: string): Promise<number | null> {
    const city = await this.prisma.city.findUnique({ where: { name: cityName } });
    if (!city) return null;
    const svc = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!svc) return null;
    const cs = await this.prisma.cityService.findUnique({
      where: { cityId_serviceId: { cityId: city.id, serviceId } },
    });
    if (cs && !cs.isActive) return null; // explicitly disabled for this city
    if (cs && cs.customPrice) return Number(cs.customPrice); // service-level override wins
    return Number(svc.basePrice) * Number(city.priceMultiplier);
  }

  // Admin: configure city
  async setActiveServices(cityName: string, serviceKeys: string[]) {
    return this.prisma.city.update({
      where: { name: cityName },
      data: { activeServiceKeys: serviceKeys },
    });
  }

  async setPriceMultiplier(cityName: string, multiplier: number) {
    return this.prisma.city.update({
      where: { name: cityName },
      data: { priceMultiplier: multiplier },
    });
  }
}

@ApiTags('Cities')
@Controller('cities')
export class CitiesController {
  constructor(private cities: CitiesService) {}

  @Public() @Get()
  list() { return this.cities.list(); }

  @Public() @Get('serviceability')
  check(@Query('pincode') pincode: string) { return this.cities.checkServiceability(pincode); }

  @Public() @Get(':name/services')
  activeServices(@Param('name') name: string) {
    return this.cities.getActiveServicesForCity(name);
  }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Patch(':name/services')
  setServices(@Param('name') name: string, @Body() body: { serviceKeys: string[] }) {
    return this.cities.setActiveServices(name, body.serviceKeys);
  }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Patch(':name/pricing')
  setPricing(@Param('name') name: string, @Body() body: { multiplier: number }) {
    return this.cities.setPriceMultiplier(name, body.multiplier);
  }
}

@Module({
  controllers: [CitiesController],
  providers: [CitiesService],
  exports: [CitiesService],
})
export class CitiesModule {}
