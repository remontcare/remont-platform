import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { OrderStatus, OrderType, BookingChannel, UserRole } from '@prisma/client';
import { IsString, IsOptional, IsEnum, IsArray, IsNumber, IsDateString, IsEmail, IsIn, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, haversineKm } from '../../common';
import { CouponsService, CouponsModule } from '../coupons/coupons.module';
import { MembershipsService, MembershipsModule } from '../memberships/memberships.module';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';

// ─── Public Product Checkout DTO ───
class PublicCheckoutItemDto {
  @IsString() productId: string;
  @IsNumber() @Min(1) quantity: number;
}

class PublicProductCheckoutDto {
  @IsString() name: string;
  @IsString() phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PublicCheckoutItemDto) items: PublicCheckoutItemDto[];
  @IsString() fullAddress: string;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsString() landmark?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsNumber() accuracy?: number;
  @IsOptional() @IsString() locationSource?: string;
  @IsOptional() @IsString() capturedAt?: string;
  @IsIn(['ONLINE', 'COD']) paymentMethod: 'ONLINE' | 'COD';
}

// ─── Guest Booking DTO ───
class GuestBookingDto {
  @IsString() name: string;
  @IsString() phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() serviceId: string;
  @IsString() cityId: string;
  @IsString() fullAddress: string;
  @IsOptional() @IsString() pincode?: string;
  @IsDateString() slotDate: string;
  @IsString() slotTime: string; // e.g. "10:00", "14:00", "18:00"
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(BookingChannel) channel?: BookingChannel;
}

// ─── DTOs ───
class OrderItemDto {
  @IsString() productId: string;
  @IsNumber() @Min(1) quantity: number;
}

class InlineAddressDto {
  @IsOptional() @IsString() label?: string;
  @IsString() fullAddress: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
}

class CreateOrderDto {
  @IsEnum(OrderType) type: OrderType;
  @IsOptional() @IsEnum(BookingChannel) channel?: BookingChannel;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items?: OrderItemDto[];
  @IsOptional() @IsString() addressId?: string;
  @IsOptional() @ValidateNested() @Type(() => InlineAddressDto) inlineAddress?: InlineAddressDto;
  @IsOptional() @IsDateString() slotStart?: string;
  @IsOptional() @IsDateString() slotEnd?: string;
  @IsOptional() @IsString() couponCode?: string;
  @IsOptional() @IsNumber() @Min(0) walletAmount?: number;
  @IsOptional() @IsString() aiSessionId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() guestName?: string;
  @IsOptional() @IsString() guestPhone?: string;
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
        if (!p) throw new NotFoundException(`Product not found: ${item.productId}`);
        const total = Number(p.price) * item.quantity;
        productsAmount += total;
        itemInputs.push({ productId: item.productId, quantity: item.quantity, unitPrice: p.price, totalPrice: total });
      }
    }

    // Resolve addressId: if an inline address is provided and no addressId, create one
    let resolvedAddressId = dto.addressId;
    if (!resolvedAddressId && dto.inlineAddress) {
      const addr = await this.prisma.address.create({
        data: {
          userId: customerId,
          label: dto.inlineAddress.label || 'Delivery Address',
          fullAddress: dto.inlineAddress.fullAddress,
          city: dto.inlineAddress.city || '',
          state: dto.inlineAddress.state || '',
          pincode: dto.inlineAddress.pincode || '',
          latitude: 0,
          longitude: 0,
        },
      });
      resolvedAddressId = addr.id;
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

    const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const order = await this.prisma.order.create({
      data: {
        orderNumber, customerId,
        type: dto.type, channel: dto.channel || BookingChannel.WEBSITE,
        serviceId: dto.serviceId, addressId: resolvedAddressId,
        slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
        slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
        startOtp, status: OrderStatus.PENDING_PAYMENT,
        serviceAmount, productsAmount, subtotal,
        couponCode: dto.couponCode, couponDiscount, membershipDiscount,
        walletUsed, gstAmount, totalAmount, remontCommission, vendorPayout,
        aiSessionId: dto.aiSessionId, leadId: dto.leadId,
        guestName: dto.guestName,
        guestPhone: dto.guestPhone,
        items: itemInputs.length ? { create: itemInputs } : undefined,
      },
      include: { items: true, service: true, address: true },
    });

    if (couponId) await this.coupons.recordUsage(couponId, customerId, order.id, couponDiscount);

    if (walletUsed > 0) {
      const user = await this.prisma.user.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
      if (!user || Number(user.walletBalance) < walletUsed) {
        throw new BadRequestException('Insufficient wallet balance');
      }
      const newBalance = Number(user.walletBalance) - walletUsed;
      await this.prisma.user.update({ where: { id: customerId }, data: { walletBalance: { decrement: walletUsed } } });
      await this.prisma.walletTransaction.create({
        data: {
          userId: customerId,
          type: 'DEBIT',
          reason: 'ORDER_PAYMENT',
          amount: walletUsed,
          balanceAfter: newBalance,
          orderId: order.id,
          notes: `Payment for order ${order.orderNumber}`,
        },
      });
    }

    return order;
  }

  async confirmPayment(orderId: string, paymentId: string, gatewayOrderId?: string, signature?: string) {
    if (gatewayOrderId && signature) {
      // Re-verify HMAC on every confirm call — cannot be faked without RAZORPAY_KEY_SECRET
      if (!process.env.RAZORPAY_KEY_SECRET) throw new BadRequestException('Payment gateway not configured');
      const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${gatewayOrderId}|${paymentId}`)
        .digest('hex');
      if (expected !== signature) throw new BadRequestException('Invalid payment signature');

      // Ensure this gatewayOrderId is actually linked to this DB order (prevents reusing another order's payment)
      const linkedTx = await this.prisma.paymentTransaction.findFirst({
        where: { gatewayOrderId, orderId },
      });
      if (!linkedTx) throw new BadRequestException('Payment does not belong to this order');
    } else {
      // Fallback: require a pre-verified PaymentTransaction (set by webhook or /payments/verify)
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { orderId, status: 'PAID' } });
      if (!tx) throw new BadRequestException('Payment not verified. Contact support.');
    }

    const existing = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) throw new NotFoundException('Order not found');
    if (existing.paymentStatus === 'PAID') return existing; // Idempotent
    if (existing.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Order cannot be confirmed in its current state');
    }

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
    if (order.status !== OrderStatus.VENDOR_EN_ROUTE) throw new BadRequestException('Order is not en-route');
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
    if (!['STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'].includes(order.status)) {
      throw new BadRequestException('Order cannot be completed at this stage');
    }
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
    this.autoGenerateInvoice(orderId).catch((e) => this.logger.warn(`Auto-invoice failed: ${e.message}`));
    return completed;
  }

  private async autoGenerateInvoice(orderId: string) {
    const existing = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (existing) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { extraWorkItems: { where: { customerApproved: true } } },
    });
    if (!order) return;
    const customerSubtotal = Number(order.subtotal);
    const customerTotal = Number(order.totalAmount);
    const customerCgst = Math.round((Number(order.gstAmount) / 2) * 100) / 100;
    const customerSgst = customerCgst;
    const vendorLabor = Number(order.serviceAmount) + order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
    const vendorCgst = Math.round(vendorLabor * 0.09 * 100) / 100;
    const vendorSgst = vendorCgst;
    const vendorTotal = vendorLabor + vendorCgst + vendorSgst;
    const platformCommission = Number(order.remontCommission);
    const bookingFee = 49;
    const remontPretax = platformCommission + bookingFee;
    const remontCgst = Math.round(remontPretax * 0.09 * 100) / 100;
    const remontSgst = remontCgst;
    const remontTotal = remontPretax + remontCgst + remontSgst;
    const count = await this.prisma.invoice.count();
    const invoiceNumber = `INV-${order.orderNumber}-${(count + 1).toString().padStart(4, '0')}`;
    await this.prisma.invoice.create({
      data: {
        invoiceNumber, orderId,
        customerSubtotal, customerCgst, customerSgst, customerTotal,
        vendorLabor, vendorMaterial: 0, vendorCgst, vendorSgst, vendorTotal,
        platformCommission, bookingFee, remontCgst, remontSgst, remontTotal,
      },
    });
    await this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.INVOICED } });
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

// ─── Guest Booking Service (no auth required) ───
@Injectable()
export class GuestBookingService {
  private readonly logger = new Logger(GuestBookingService.name);
  constructor(private prisma: PrismaService, private dispatch: DispatchService, private payments: PaymentsService) {}

  async book(dto: GuestBookingDto) {
    // Find or create customer by phone
    let user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone: dto.phone,
          name: dto.name,
          email: dto.email || undefined,
          role: UserRole.CUSTOMER,
          isVerified: true,
        },
      });
    }

    // Verify service exists
    const svc = await this.prisma.service.findUnique({
      where: { id: dto.serviceId },
      include: { category: true },
    });
    if (!svc || !svc.isActive) throw new NotFoundException('Service not found or inactive');

    // Verify city
    const city = await this.prisma.city.findUnique({ where: { id: dto.cityId } });
    if (!city || !city.isActive) throw new NotFoundException('City not available');

    // Determine price (city override or base price)
    const cityService = await this.prisma.cityService.findUnique({
      where: { cityId_serviceId: { cityId: dto.cityId, serviceId: dto.serviceId } },
    });
    const serviceAmount = (cityService?.isActive && cityService.customPrice)
      ? Number(cityService.customPrice)
      : Number(svc.basePrice);

    const gstAmount = Math.round(serviceAmount * 0.18 * 100) / 100;
    const totalAmount = serviceAmount + gstAmount;

    // Parse slot datetime as IST (UTC+5:30) to avoid local-timezone drift
    const paddedTime = dto.slotTime.length === 5 ? dto.slotTime : `${dto.slotTime}:00`;
    const slotStart = new Date(`${dto.slotDate}T${paddedTime}:00+05:30`);
    const slotEnd = new Date(slotStart.getTime() + svc.durationMinutes * 60 * 1000);

    const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Create address inline (full address as free text)
    const address = await this.prisma.address.create({
      data: {
        userId: user.id,
        label: 'Booking Address',
        fullAddress: dto.fullAddress,
        city: city.name,
        state: city.state,
        pincode: dto.pincode || '000000',
        latitude: city.latitude,
        longitude: city.longitude,
        isDefault: false,
      },
    });

    const order = await this.prisma.order.create({
      data: {
        orderNumber,
        customerId: user.id,
        serviceId: dto.serviceId,
        addressId: address.id,
        type: OrderType.SERVICE,
        channel: dto.channel || BookingChannel.WEBSITE,
        status: OrderStatus.CONFIRMED,
        paymentStatus: 'PENDING',
        guestName: dto.name,
        guestPhone: dto.phone,
        guestEmail: dto.email || null,
        adminNotes: dto.notes || null,
        slotStart,
        slotEnd,
        startOtp,
        serviceAmount,
        productsAmount: 0,
        subtotal: serviceAmount,
        couponDiscount: 0,
        membershipDiscount: 0,
        walletUsed: 0,
        gstAmount,
        totalAmount,
        remontCommission: Math.round(serviceAmount * 0.15 * 100) / 100,
        vendorPayout: serviceAmount - Math.round(serviceAmount * 0.15 * 100) / 100,
      },
      include: {
        service: { select: { name: true, durationMinutes: true } },
        address: true,
        customer: { select: { name: true, phone: true } },
      },
    });

    this.logger.log(`📋 Guest booking: ${orderNumber} for ${dto.name} (${dto.phone})`);
    this.dispatch.dispatch(order.id).catch((e) => this.logger.error(`Guest dispatch failed: ${e.message}`));
    return {
      orderNumber: order.orderNumber,
      orderId: order.id,
      status: order.status,
      service: order.service?.name,
      slot: slotStart.toISOString(),
      city: city.name,
      totalAmount: order.totalAmount,
      message: 'Booking confirmed! Our team will contact you within 30 minutes.',
    };
  }

  async publicProductCheckout(dto: PublicProductCheckoutDto) {
    // Find or create customer by phone
    let user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { phone: dto.phone, name: dto.name, email: dto.email || undefined, role: UserRole.CUSTOMER, isVerified: true },
      });
    } else if (dto.name && !user.name) {
      await this.prisma.user.update({ where: { id: user.id }, data: { name: dto.name } });
    }

    if (!dto.items?.length) throw new BadRequestException('No items in order');

    let productsAmount = 0;
    const itemInputs: any[] = [];
    for (const item of dto.items) {
      const p = await this.prisma.product.findUnique({ where: { id: item.productId } });
      if (!p) throw new NotFoundException(`Product not found: ${item.productId}`);
      const lineTotal = Number(p.price) * item.quantity;
      productsAmount += lineTotal;
      itemInputs.push({ productId: item.productId, quantity: item.quantity, unitPrice: p.price, totalPrice: lineTotal });
    }

    const gstAmount = Math.round(productsAmount * 0.18 * 100) / 100;
    const totalAmount = productsAmount + gstAmount;

    const lat = dto.latitude || 0;
    const lng = dto.longitude || 0;
    const validCoords = lat !== 0 && lng !== 0 && lat >= 6.5 && lat <= 37.6 && lng >= 68.1 && lng <= 97.4;
    const address = await this.prisma.address.create({
      data: {
        userId: user.id, label: 'Delivery Address',
        fullAddress: dto.fullAddress,
        area: dto.area || '', landmark: dto.landmark || '',
        city: dto.city || '', state: dto.state || '', country: 'India',
        pincode: dto.pincode || '',
        latitude:  validCoords ? lat : 0,
        longitude: validCoords ? lng : 0,
        accuracy:  dto.accuracy || null,
        locationSource: dto.locationSource || 'MANUAL',
        capturedAt: dto.capturedAt ? new Date(dto.capturedAt) : null,
      },
    });

    const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const isCOD = dto.paymentMethod === 'COD';

    const order = await this.prisma.order.create({
      data: {
        orderNumber, customerId: user.id, type: OrderType.PRODUCT,
        channel: BookingChannel.WEBSITE, addressId: address.id,
        guestName: dto.name, guestPhone: dto.phone, guestEmail: dto.email || null,
        productsAmount, subtotal: productsAmount, gstAmount, totalAmount,
        startOtp: Math.floor(1000 + Math.random() * 9000).toString(),
        remontCommission: 0, vendorPayout: 0,
        status: isCOD ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT,
        paymentStatus: 'PENDING',
        adminNotes: isCOD ? 'COD order' : null,
        items: { create: itemInputs },
      },
    });

    if (isCOD) {
      return { orderNumber: order.orderNumber, orderId: order.id, totalAmount, paymentMethod: 'COD', isCOD: true };
    }

    // Create Razorpay order — throws BadRequestException if gateway not configured
    const rzpOrder = await this.payments.createOrder(user.id, totalAmount, order.id);
    return {
      orderNumber: order.orderNumber, orderId: order.id, totalAmount,
      paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
      gatewayOrderId: rzpOrder.gatewayOrderId,
      razorpayKeyId: rzpOrder.keyId,
      txId: rzpOrder.txId,
    };
  }

  async trackOrder(orderNumber: string, phone: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
      include: {
        service: { select: { name: true, imageUrl: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        address: { select: { city: true, fullAddress: true } },
        extraWorkItems: { where: { customerApproved: false } },
        customer: { select: { phone: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    // Verify phone matches
    const ownerPhone = order.guestPhone || order.customer?.phone;
    if (ownerPhone && ownerPhone !== phone) throw new ForbiddenException('Access denied');

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      service: order.service?.name,
      slotStart: order.slotStart,
      vendor: order.vendor ? {
        name: order.vendor.user?.name || order.vendor.fullName,
        phone: order.vendor.user?.phone,
      } : null,
      city: order.address?.city,
      totalAmount: order.totalAmount,
      pendingApprovals: order.extraWorkItems.length,
      createdAt: order.createdAt,
    };
  }
}

@ApiTags('Orders')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrdersService, private extras: ExtraWorkService) {}

  @Post() create(@CurrentUser() u: JwtPayload, @Body() dto: CreateOrderDto) { return this.orders.create(u.sub, dto); }
  @Post(':id/confirm-payment') pay(@Param('id') id: string, @Body() b: { paymentId: string; gatewayOrderId?: string; signature?: string }) { return this.orders.confirmPayment(id, b.paymentId, b.gatewayOrderId, b.signature); }
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

// ─── Public (no-auth) booking controller ───
@ApiTags('Booking')
@Controller('orders/public')
export class PublicBookingController {
  constructor(private guest: GuestBookingService, private orders: OrdersService) {}

  @Post('book') book(@Body() dto: GuestBookingDto) { return this.guest.book(dto); }
  @Post('checkout') checkout(@Body() dto: PublicProductCheckoutDto) { return this.guest.publicProductCheckout(dto); }

  // Atomic verify+confirm for guest checkout — HMAC signature is the proof of payment (no JWT needed)
  @Post('confirm-payment')
  confirmPayment(@Body() b: { dbOrderId: string; gatewayOrderId: string; paymentId: string; signature: string }) {
    return this.orders.confirmPayment(b.dbOrderId, b.paymentId, b.gatewayOrderId, b.signature);
  }

  @Get('track/:orderNumber') track(@Param('orderNumber') num: string, @Query('phone') phone: string) {
    return this.guest.trackOrder(num, phone);
  }
}

@Module({
  imports: [CouponsModule, MembershipsModule, WhatsappModule, CitiesModule, PaymentsModule],
  controllers: [OrdersController, PublicBookingController],
  providers: [OrdersService, DispatchService, ExtraWorkService, GuestBookingService],
  exports: [OrdersService],
})
export class OrdersModule {}
