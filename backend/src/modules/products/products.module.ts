import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public, CurrentUser, JwtPayload, slugify } from '../../common';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  constructor(private prisma: PrismaService) {}

  async list(opts: { category?: string; vendor?: string; q?: string; city?: string; limit?: number }) {
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(opts.category ? { category: { key: opts.category } } : {}),
        ...(opts.vendor ? { vendorId: opts.vendor } : {}),
        ...(opts.q ? {
          OR: [
            { name: { contains: opts.q, mode: 'insensitive' } },
            { brand: { contains: opts.q, mode: 'insensitive' } },
            { description: { contains: opts.q, mode: 'insensitive' } },
          ],
        } : {}),
      },
      include: { category: true, vendor: { select: { businessName: true, rating: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
    });

    // City-wise filter
    if (opts.city) {
      const city = await this.prisma.city.findUnique({ where: { name: opts.city } });
      if (city) {
        const inactive = await this.prisma.cityProduct.findMany({
          where: { cityId: city.id, isActive: false },
          select: { productId: true },
        });
        const inactiveSet = new Set(inactive.map((c) => c.productId));
        return products.map((p) => ({ ...p, _unavailable: inactiveSet.has(p.id) }));
      }
    }
    return products;
  }

  async getBySlug(slug: string) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: { category: true, vendor: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    this.prisma.product.update({ where: { id: product.id }, data: { views: { increment: 1 } } }).catch(() => undefined);
    return product;
  }

  async create(userId: string, data: any) {
    const vendor = await this.prisma.productVendor.findUnique({ where: { userId } });
    if (!vendor) throw new ForbiddenException('Not a product vendor');

    const slug = slugify(`${data.name}-${Date.now()}`);
    const sku = data.sku || `RMNT-${Date.now()}`;

    const product = await this.prisma.product.create({
      data: { ...data, slug, sku, vendorId: vendor.id, aiGeneratedDesc: null, aiEnhancedImgs: [] },
    });

    // Background AI enhancement
    this.runAiEnhancement(product.id, data.name, data.brand, data.images || [])
      .catch((e) => this.logger.error(`AI enhancement failed: ${e.message}`));

    return product;
  }

  async update(userId: string, id: string, data: any) {
    const vendor = await this.prisma.productVendor.findUnique({ where: { userId } });
    if (!vendor) throw new ForbiddenException('Not a vendor');
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing || existing.vendorId !== vendor.id) throw new ForbiddenException();
    return this.prisma.product.update({ where: { id }, data });
  }

  async myProducts(userId: string) {
    const vendor = await this.prisma.productVendor.findUnique({ where: { userId } });
    if (!vendor) throw new ForbiddenException();
    return this.prisma.product.findMany({
      where: { vendorId: vendor.id },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Rule-based placeholder — swap with OpenAI/Replicate for real LLM */
  private async runAiEnhancement(productId: string, name: string, brand?: string, images?: string[]) {
    const desc = `Discover the ${brand ? brand + ' ' : ''}${name} — engineered for everyday excellence. Premium materials, modern design, and trusted quality. Comes with full warranty and free installation by Remont's verified technicians.`;
    await this.prisma.product.update({
      where: { id: productId },
      data: { aiGeneratedDesc: desc, aiEnhancedImgs: images || [] },
    });
  }
}

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private products: ProductsService) {}

  @Public() @Get()
  list(
    @Query('category') category?: string,
    @Query('vendor') vendor?: string,
    @Query('q') q?: string,
    @Query('city') city?: string,
    @Query('limit') limit?: number,
  ) { return this.products.list({ category, vendor, q, city, limit }); }

  @Public() @Get(':slug')
  one(@Param('slug') slug: string) { return this.products.getBySlug(slug); }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.PRODUCT_VENDOR)
  @ApiBearerAuth() @Get('vendor/mine')
  mine(@CurrentUser() u: JwtPayload) { return this.products.myProducts(u.sub); }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.PRODUCT_VENDOR)
  @ApiBearerAuth() @Post()
  create(@CurrentUser() u: JwtPayload, @Body() body: any) { return this.products.create(u.sub, body); }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.PRODUCT_VENDOR)
  @ApiBearerAuth() @Patch(':id')
  update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() body: any) {
    return this.products.update(u.sub, id, body);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
