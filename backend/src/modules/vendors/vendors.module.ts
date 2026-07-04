import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';

// ─── Service Vendor ───
@Injectable()
export class ServiceVendorsService {
  constructor(private prisma: PrismaService, private wa: WhatsappService) {}

  async register(userId: string, data: any) {
    // Strip fields a vendor must not self-assign
    const { status, rating, completedJobs, totalEarnings, pendingPayout, isOnline, ...safeData } = data;
    return this.prisma.serviceVendor.upsert({
      where: { userId },
      create: { userId, ...safeData },
      update: safeData,
    });
  }

  async profile(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({
      where: { userId },
      include: { documents: true, issuedInventory: { include: { product: true } } },
    });
    if (!v) throw new NotFoundException('Vendor profile not found');
    return v;
  }

  async updateLocation(userId: string, lat: number, lng: number) {
    return this.prisma.serviceVendor.update({
      where: { userId },
      data: { currentLatitude: lat, currentLongitude: lng, lastLocationUpdate: new Date(), isOnline: true },
      select: { id: true, isOnline: true },
    });
  }

  async setOnlineStatus(userId: string, isOnline: boolean) {
    return this.prisma.serviceVendor.update({ where: { userId }, data: { isOnline } });
  }

  async earnings(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);
    const [today, month] = await Promise.all([
      this.prisma.order.aggregate({
        where: { vendorId: v.id, status: 'COMPLETED', completedAt: { gte: sod } },
        _sum: { vendorPayout: true }, _count: true,
      }),
      this.prisma.order.aggregate({
        where: { vendorId: v.id, status: 'COMPLETED', completedAt: { gte: som } },
        _sum: { vendorPayout: true }, _count: true,
      }),
    ]);
    return {
      today: { earnings: today._sum.vendorPayout || 0, jobs: today._count },
      thisMonth: { earnings: month._sum.vendorPayout || 0, jobs: month._count },
      lifetime: { amount: v.totalEarnings, pending: v.pendingPayout },
    };
  }

  async myJobs(userId: string, status?: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    return this.prisma.order.findMany({
      where: { vendorId: v.id, ...(status ? { status: status as any } : {}) },
      include: {
        customer: { select: { name: true, phone: true } },
        service: true, address: true, extraWorkItems: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async availableJobs(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    return this.prisma.order.findMany({
      where: { vendorId: null, status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] as any[] } },
      include: {
        service: { select: { name: true, categoryId: true } },
        address: { select: { fullAddress: true, city: true, pincode: true, latitude: true, longitude: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
  }

  async acceptJob(userId: string, orderId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException();
    if (order.vendorId && order.vendorId !== v.id) throw new BadRequestException('Already assigned');

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { vendorId: v.id, status: 'VENDOR_ASSIGNED' },
      include: { customer: true, address: true, service: true },
    });
    await this.wa.sendJobAssigned(v.userId, updated);
    return updated;
  }
}

@ApiTags('Vendors')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SERVICE_VENDOR)
@Controller('vendors/service')
export class ServiceVendorsController {
  constructor(private vs: ServiceVendorsService) {}
  @Post('register') reg(@CurrentUser() u: JwtPayload, @Body() b: any) { return this.vs.register(u.sub, b); }
  @Get('me') me(@CurrentUser() u: JwtPayload) { return this.vs.profile(u.sub); }
  @Patch('me/location') loc(@CurrentUser() u: JwtPayload, @Body() b: { lat: number; lng: number }) { return this.vs.updateLocation(u.sub, b.lat, b.lng); }
  @Patch('me/status') status(@CurrentUser() u: JwtPayload, @Body() b: { isOnline: boolean }) { return this.vs.setOnlineStatus(u.sub, b.isOnline); }
  @Get('me/earnings') earn(@CurrentUser() u: JwtPayload) { return this.vs.earnings(u.sub); }
  @Get('me/jobs') jobs(@CurrentUser() u: JwtPayload, @Query('status') s?: string) { return this.vs.myJobs(u.sub, s); }
  @Get('me/available-jobs') availJobs(@CurrentUser() u: JwtPayload) { return this.vs.availableJobs(u.sub); }
  @Post('me/jobs/:orderId/accept') accept(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) { return this.vs.acceptJob(u.sub, id); }
}

// ─── Product Vendor ───
@Injectable()
export class ProductVendorsService {
  constructor(private prisma: PrismaService) {}

  async register(userId: string, data: any) {
    const { status, rating, totalEarnings, ...safeData } = data;
    return this.prisma.productVendor.upsert({ where: { userId }, create: { userId, ...safeData }, update: safeData });
  }

  async profile(userId: string) {
    const v = await this.prisma.productVendor.findUnique({
      where: { userId },
      include: { products: { take: 50, orderBy: { createdAt: 'desc' } } },
    });
    if (!v) throw new NotFoundException();
    return v;
  }

  async dashboard(userId: string) {
    const v = await this.prisma.productVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    const [total, orders, revenue, lowStock] = await Promise.all([
      this.prisma.product.count({ where: { vendorId: v.id } }),
      this.prisma.orderItem.count({ where: { product: { vendorId: v.id } } }),
      this.prisma.orderItem.aggregate({
        where: { product: { vendorId: v.id }, order: { status: 'COMPLETED' } },
        _sum: { totalPrice: true },
      }),
      this.prisma.product.count({ where: { vendorId: v.id, stock: { lte: 5 } } }),
    ]);
    return {
      totalProducts: total, totalOrders: orders,
      totalRevenue: revenue._sum.totalPrice || 0,
      lowStockCount: lowStock, rating: v.rating,
    };
  }
}

@ApiTags('Vendors')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PRODUCT_VENDOR)
@Controller('vendors/product')
export class ProductVendorsController {
  constructor(private pv: ProductVendorsService) {}
  @Post('register') reg(@CurrentUser() u: JwtPayload, @Body() b: any) { return this.pv.register(u.sub, b); }
  @Get('me') me(@CurrentUser() u: JwtPayload) { return this.pv.profile(u.sub); }
  @Get('me/dashboard') dash(@CurrentUser() u: JwtPayload) { return this.pv.dashboard(u.sub); }
}

@Module({
  imports: [WhatsappModule],
  controllers: [ServiceVendorsController, ProductVendorsController],
  providers: [ServiceVendorsService, ProductVendorsService],
  exports: [ServiceVendorsService, ProductVendorsService],
})
export class VendorsModule {}
