import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { OrderStatus, OrderType, BookingChannel } from '@prisma/client';
import { IsString, IsOptional, IsEnum, IsArray, IsNumber, IsDateString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, haversineKm, generateOrderNumber } from '../../common';
import { CouponsService, CouponsModule } from '../coupons/coupons.module';
import { MembershipsService, MembershipsModule } from '../memberships/memberships.module';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';

// ─── DTOs ───
class OrderItemDto {
  @IsString() productId: string;
  @IsNumber() @Min(1) quantity: number;
}
class CreateOrderDto {
  @IsEnum(OrderType) type: OrderType;
  @IsOptional() @IsEnum(BookingChannel) channel?: BookingChannel;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items?: OrderItemDto[];
  @IsOptional() @IsString() addressId?: string;
  @IsOptional() @IsDateString() slotStart?: string;
  @IsOptional() @IsDateString() slotEnd?: string;
  @IsOptional() @IsString() couponCode?: string;
  @IsOptional() @IsNumber() @Min(0) walletAmount?: number;
  @IsOptional() @IsString() aiSessionId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() city?: string;
}

// ─── Dispatch (smart vendor matching) ───
@Injectable()
class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  constructor(private prisma: PrismaService, private wa: WhatsappService) {}

  async dispatch(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { address: true, service: { include: { category: true } } },
    });
    if (!order?.address || !order.service) return [];

    const { latitude: lat, longitude: lng } = order.address;
    const skill = order.service.category.key;

    const vendors = await this.prisma.serviceVendor.findMany({
      where: {
        isOnline: true, status: 'ACTIVE',
        skills: { has: skill },
        currentLatitude: { not: null }, currentLongitude: { not: null },
      },
      include: { user: true },
      take: 50,
    });

    const candidates = vendors
      .map((v) => {
        const d = haversineKm(lat, lng, v.currentLatitude!, v.currentLongitude!);
        if (d > v.serviceRadius) return null;
        const score = (v.rating / 5) * 50 + Math.max(0, 50 - d * 5) + (v.isVipPro ? 10 : 0);
        return { vendorId: v.id, userId: v.userId, distance: d, rating: v.rating, score };
      })
      .filter(Boolean) as any[];

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 5);
    for (const c of top) {
      try { await this.wa.sendJobAssigned(c.userId, order); } catch (e) {
        this.logger.warn(`Notify failed: ${e.message}`);
      }
    }
    this.logger.log(`📡 Dispatched ${order.orderNumber} to ${top.length} vendors`);
    return top;
  }
}

// ─── Extra work service ───
@Injectable()
class ExtraWorkService {
  constructor(private prisma: PrismaService, private wa: WhatsappService) {}

  async addExtraWork(vendorUserId: string, orderId: string, description: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Invalid amount');
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!vendor) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
    if (!order) throw new NotFoundException();
    if (order.vendorId !== vendor.id) throw new ForbiddenException();
    if (!['STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'].includes(order.status)) {
      throw new BadRequestException('Cannot add extras at this stage');
    }
    const extra = await this.prisma.extraWorkItem.create({
      data: { orderId, description, amount, addedBy: vendor.id, customerApproved: false },
    });
    await this.recalc(orderId);
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'EXTRA_WORK_ADDED' } });
    await this.wa.sendExtraWorkApproval(order.customer.phone, order.orderNumber, description, amount);
    return extra;
  }

  async approve(customerId: string, extraId: string) {
    const extra = await this.prisma.extraWorkItem.findUnique({ where: { id: extraId }, include: { order: true } });
    if (!extra) throw new NotFoundException();
    if (extra.order.customerId !== customerId) throw new ForbiddenException();
    const updated = await this.prisma.extraWorkItem.update({
      where: { id: extraId },
      data: { customerApproved: true, approvedAt: new Date() },
    });
    await this.recalc(extra.orderId);
    return updated;
  }

  private async recalc(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { extraWorkItems: { where: { customerApproved: true } } },
    });
    if (!order) return;
    const extraTotal = order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
    const subtotal = Number(order.serviceAmount) + Number(order.productsAmount) + extraTotal;
    const gst = Math.round(subtotal * 0.18 * 100) / 100;
    const discount = Number(order.couponDiscount) + Number(order.membershipDiscount) + Number(order.walletUsed);
    const total = Math.max(0, subtotal + gst - discount);
    const commission = Math.round(Number(order.serviceAmount) * 0.15 * 100) / 100;
    const payout = Number(order.serviceAmount) + extraTotal - commission;
    await this.prisma.order.update({
      where: { id: orderId },
      data: { extraWorkAmount: extraTotal, subtotal, gstAmount: gst, totalAmount: total, remontCommission: commission, vendorPayout: payout },
    });
  }
}

// ─── Main Orders service ───
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private prisma: PrismaService,
    private coupons: CouponsService,
    private memberships: MembershipsService,
    private dispatch: DispatchService,
    private cities: CitiesService,
  ) {}

  async create(customerId: string, dto: CreateOrderDto) {
    let serviceAmount = 0;
    let productsAmount = 0;
    const itemInputs: any[] = [];

    if (dto.serviceId) {
      const svc = await this.prisma.service.findUnique({ where: { id: dto.serviceId } });
      if (!svc) throw new NotFoundException('Service not found');
      // City-wise price override
      if (dto.city) {
        const cityPrice = await this.cities.getServicePrice(dto.city, svc.id);
        serviceAmount = cityPrice !== null ? cityPrice : Number(svc.basePrice);
      } else {
        serviceAmount = Number(svc.basePrice);
      }
    }

    if (dto.items?.length) {
      for (const item of dto.items) {
        const p = await this.prisma.product.findUnique({ where: { id: item.productId } });
        if (!p) throw new NotFoundException();
        const total = Number(p.price) * item.quantity;
        productsAmount += total;
        itemInputs.push({ productId: item.productId, quantity: item.quantity, unitPrice: p.price, totalPrice: total });
      }
    }

    let subtotal = serviceAmount + productsAmount;
    const membershipPct = await this.memberships.getActiveDiscount(customerId);
    const membershipDiscount = Math.round((subtotal * membershipPct) / 100 * 100) / 100;

    let couponDiscount = 0;
    let couponId: string | undefined;
    if (dto.couponCode) {
      const v = await this.coupons.validate(dto.couponCode, customerId, subtotal - membershipDiscount);
      if (!v.valid) throw new BadRequestException(v.reason);
      couponDiscount = v.discountAmount || 0;
      couponId = v.coupon?.id;
    }

    const discountedSubtotal = subtotal - membershipDiscount - couponDiscount;
    const gstAmount = Math.round(discountedSubtotal * 0.18 * 100) / 100;
    const walletUsed = Math.min(dto.walletAmount || 0, discountedSubtotal + gstAmount);
    const totalAmount = Math.max(0, discountedSubtotal + gstAmount - walletUsed);
    const remontCommission = Math.round(serviceAmount * 0.15 * 100) / 100;
    const vendorPayout = serviceAmount - remontCommission;

    const count = await this.prisma.order.count();
    const orderNumber = generateOrderNumber('REM', count);
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const order = await this.prisma.order.create({
      data: {
        orderNumber, customerId,
        type: dto.type, channel: dto.channel || BookingChannel.WEBSITE,
        serviceId: dto.serviceId, addressId: dto.addressId,
        slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
        slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
        startOtp, status: OrderStatus.PENDING_PAYMENT,
        serviceAmount, productsAmount, subtotal,
        couponCode: dto.couponCode, couponDiscount, membershipDiscount,
        walletUsed, gstAmount, totalAmount, remontCommission, vendorPayout,
        aiSessionId: dto.aiSessionId, leadId: dto.leadId,
        items: itemInputs.length ? { create: itemInputs } : undefined,
      },
      include: { items: true, service: true, address: true },
    });

    if (couponId) await this.coupons.recordUsage(couponId, customerId, order.id, couponDiscount);
    return order;
  }

  async confirmPayment(orderId: string, paymentId: string) {
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: { paymentId, paymentStatus: 'PAID', status: OrderStatus.CONFIRMED },
    });
    if (order.serviceId) {
      this.dispatch.dispatch(order.id).catch((e) => this.logger.error(`Dispatch failed: ${e.message}`));
    }
    return order;
  }

  async markEnRoute(vendorUserId: string, orderId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    return this.prisma.order.updateMany({
      where: { id: orderId, vendorId: v.id },
      data: { status: OrderStatus.VENDOR_EN_ROUTE },
    });
  }

  async verifyStartOtp(vendorUserId: string, orderId: string, otp: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (order.startOtp !== otp) throw new BadRequestException('Invalid OTP');
    return this.prisma.order.update({
      where: { id: orderId },
      data: { startOtpVerified: true, startedAt: new Date(), status: OrderStatus.STARTED },
    });
  }

  async complete(vendorUserId: string, orderId: string, photosAfter: string[], videoUrl?: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    const completed = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.COMPLETED, completedAt: new Date(), photosAfter, videoUrl },
    });
    await this.prisma.serviceVendor.update({
      where: { id: v.id },
      data: {
        completedJobs: { increment: 1 },
        totalEarnings: { increment: Number(order.vendorPayout) },
        pendingPayout: { increment: Number(order.vendorPayout) },
      },
    });
    return completed;
  }

  async myOrders(customerId: string, status?: OrderStatus) {
    return this.prisma.order.findMany({
      where: { customerId, ...(status ? { status } : {}) },
      include: {
        service: true, items: { include: { product: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        address: true, extraWorkItems: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOne(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { name: true, phone: true, email: true } },
        service: true, items: { include: { product: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        address: true, extraWorkItems: true, invoice: true,
      },
    });
    if (!order) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    return order;
  }

  async cancel(userId: string, orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerId !== userId) throw new ForbiddenException();
    if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(order.status)) {
      throw new BadRequestException('Cannot cancel at this stage');
    }
    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
    });
  }
}

@ApiTags('Orders')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrdersService, private extras: ExtraWorkService) {}

  @Post() create(@CurrentUser() u: JwtPayload, @Body() dto: CreateOrderDto) { return this.orders.create(u.sub, dto); }
  @Post(':id/confirm-payment') pay(@Param('id') id: string, @Body() b: { paymentId: string }) { return this.orders.confirmPayment(id, b.paymentId); }
  @Get('mine') mine(@CurrentUser() u: JwtPayload, @Query('status') s?: OrderStatus) { return this.orders.myOrders(u.sub, s); }
  @Get(':id') one(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.orders.getOne(u.sub, id); }
  @Patch(':id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { reason: string }) {
    return this.orders.cancel(u.sub, id, b.reason);
  }
  @Patch(':id/en-route') enRoute(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.orders.markEnRoute(u.sub, id); }
  @Post(':id/verify-otp') verify(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { otp: string }) {
    return this.orders.verifyStartOtp(u.sub, id, b.otp);
  }
  @Post(':id/extra-work') addExtra(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { description: string; amount: number }) {
    return this.extras.addExtraWork(u.sub, id, b.description, b.amount);
  }
  @Patch('extra-work/:extraId/approve') approveExtra(@CurrentUser() u: JwtPayload, @Param('extraId') id: string) {
    return this.extras.approve(u.sub, id);
  }
  @Post(':id/complete') complete(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { photosAfter: string[]; videoUrl?: string }) {
    return this.orders.complete(u.sub, id, b.photosAfter, b.videoUrl);
  }
}

@Module({
  imports: [CouponsModule, MembershipsModule, WhatsappModule, CitiesModule],
  controllers: [OrdersController],
  providers: [OrdersService, DispatchService, ExtraWorkService],
  exports: [OrdersService],
})
export class OrdersModule {}
