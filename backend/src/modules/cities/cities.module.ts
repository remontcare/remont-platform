import { Module, Injectable, Controller, Get, Query, Param, UseGuards, Post, Patch, Body } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public } from '../../common';

@Injectable()
export class CitiesService {
  constructor(private prisma: PrismaService) {}

  // City.activeVendors is a stored counter that nothing in the app ever writes to, so it
  // sits at its default of 0 for every city regardless of how many vendors actually
  // operate there — computing it from real ACTIVE ServiceVendor rows instead is what the
  // frontend's "no vendor in this city" gate needs to be trustworthy.
  async list() {
    const [cities, counts] = await Promise.all([
      this.prisma.city.findMany({ where: { isActive: true } }),
      this.prisma.serviceVendor.groupBy({
        by: ['baseCity'],
        where: { status: 'ACTIVE' },
        _count: true,
      }),
    ]);
    const countByCity = new Map(counts.map((c) => [c.baseCity, c._count]));
    return cities
      .map((city) => ({ ...city, activeVendors: countByCity.get(city.name) || 0 }))
      .sort((a, b) => b.activeVendors - a.activeVendors || a.name.localeCompare(b.name));
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
   * Resolve a service's real price for one city. Precedence, most specific wins:
   *   1. ServicePricing STANDARD-tier row for this exact (service, city)   — Admin →
   *      Service Pricing screen; the newest, most deliberately-configured override.
   *   2. CityService.customPrice for this (service, city)                 — the
   *      pre-existing per-city override, unchanged from before ServicePricing existed.
   *   3. ServicePricing STANDARD-tier row with cityId=null ("All Cities")  — a
   *      city-agnostic tier default from the same screen.
   *   4. Service.basePrice × City.priceMultiplier                         — original
   *      city-wide fallback.
   * A ServicePricing row's discountedPrice (if set) is what's actually charged;
   * basePrice on that row is otherwise the reference/list price. PREMIUM/ECONOMY
   * tier rows are intentionally not consulted here — there is no booking-flow UI yet
   * for a customer to choose a tier, so only STANDARD (the implicit default every
   * customer gets today) can affect what's actually charged.
   *
   * Nothing here changes for any (service, city) pair with zero ServicePricing rows
   * — behavior is identical to before this precedence layer was added.
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

    const [cityTier, globalTier] = await Promise.all([
      this.prisma.servicePricing.findFirst({ where: { serviceId, cityId: city.id, tier: 'STANDARD' } }),
      this.prisma.servicePricing.findFirst({ where: { serviceId, cityId: null, tier: 'STANDARD' } }),
    ]);
    const tierPrice = (row: typeof cityTier) => (row ? Number(row.discountedPrice ?? row.basePrice) : null);

    if (cityTier) return tierPrice(cityTier)!;
    if (cs && cs.customPrice) return Number(cs.customPrice); // pre-existing service-level override
    if (globalTier) return tierPrice(globalTier)!;
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
