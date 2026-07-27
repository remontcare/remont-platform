import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { OrderStatus, OrderType, BookingChannel, UserRole, PaymentCollectionMode } from '@prisma/client';
import { IsString, IsOptional, IsEnum, IsArray, IsNumber, IsDateString, IsEmail, IsIn, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, haversineKm, writeOrderTimeline, computeInvoiceBreakdown } from '../../common';
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
  // Defaults to COD for older/other clients that don't send it yet — matches the
  // pre-existing behavior this field's absence used to (silently) produce.
  @IsOptional() @IsIn(['ONLINE', 'COD']) paymentMethod?: 'ONLINE' | 'COD';
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
// Exported (and added to this module's `exports:`) so MasterOrdersModule can reuse this
// exact matching logic per child order, instead of duplicating it.
@Injectable()
export class DispatchService {
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
    private payments: PaymentsService,
  ) {}

  async create(customerId: string, dto: CreateOrderDto) {
    // City activation gate: if the order names a city that resolves to a managed City row
    // and that row is deactivated, block the order. Unresolvable/unmanaged city text is
    // allowed through unchanged — this only tightens the case we can actually verify.
    if (dto.city) {
      const city = await this.cities.getByName(dto.city);
      if (city && !city.isActive) {
        throw new BadRequestException(`${city.name} is not currently accepting orders`);
      }
    }

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
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const order = await this.prisma.order.create({
      data: {
        orderNumber, customerId,
        type: dto.type, channel: dto.channel || BookingChannel.WEBSITE,
        serviceId: dto.serviceId, addressId: resolvedAddressId,
        slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
        slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
        startOtp, endOtp, status: OrderStatus.PENDING_PAYMENT,
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

    // Allowed up to VENDOR_EN_ROUTE (not just the initial PENDING_PAYMENT confirmation) so
    // a COD order can convert to Online any time before work actually starts, per the
    // "convert COD to Online anytime before work starts" requirement — without this, calling
    // confirm-payment on an already-CONFIRMED/assigned COD order would be rejected outright.
    const confirmableStatuses: OrderStatus[] = [
      OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED, OrderStatus.VENDOR_ASSIGNED, OrderStatus.VENDOR_EN_ROUTE,
    ];
    if (!confirmableStatuses.includes(existing.status)) {
      throw new BadRequestException('Order cannot be confirmed in its current state');
    }

    const wasPendingPayment = existing.status === OrderStatus.PENDING_PAYMENT;
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentId, paymentStatus: 'PAID', paymentMethod: 'ONLINE',
        status: wasPendingPayment ? OrderStatus.CONFIRMED : existing.status,
      },
    });
    await writeOrderTimeline(this.prisma, { orderId: order.id, status: wasPendingPayment ? OrderStatus.CONFIRMED : existing.status, note: wasPendingPayment ? undefined : 'Converted from COD to Online payment' });
    // Only dispatch on the order's first confirmation — a mid-flow COD->Online conversion
    // must not re-trigger vendor matching for an order that may already have a vendor.
    if (order.serviceId && wasPendingPayment) {
      this.dispatch.dispatch(order.id).catch((e) => this.logger.error(`Dispatch failed: ${e.message}`));
    }
    return order;
  }

  /**
   * Re-initiates a gateway payment for an existing order without creating a new booking —
   * covers both a plain retry after a failed/abandoned payment, and converting a COD order
   * to Online before work starts. Guest-safe: verified by phone instead of a JWT.
   */
  async retryPayment(orderId: string, phone: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const ownerPhone = order.guestPhone;
    const owner = ownerPhone || (await this.prisma.user.findUnique({ where: { id: order.customerId }, select: { phone: true } }))?.phone;
    if (owner && owner !== phone) throw new ForbiddenException('Phone number does not match this order');
    if (order.paymentStatus === 'PAID') throw new BadRequestException('Order is already paid');
    const lockedStatuses: OrderStatus[] = [
      OrderStatus.STARTED, OrderStatus.IN_PROGRESS, OrderStatus.EXTRA_WORK_ADDED,
      OrderStatus.COMPLETED, OrderStatus.INVOICED, OrderStatus.CLOSED,
      OrderStatus.CANCELLED, OrderStatus.REFUNDED,
    ];
    if (lockedStatuses.includes(order.status)) {
      throw new BadRequestException('Payment can no longer be changed for this order');
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    const payOrder: any = await this.payments.initiatePayment(order.customerId, Number(order.totalAmount), order.id, frontendUrl);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      gateway: payOrder.gateway,
      gatewayOrderId: payOrder.gatewayOrderId,
      razorpayKeyId: payOrder.keyId,
      redirectUrl: payOrder.redirectUrl,
      txId: payOrder.txId,
    };
  }

  /**
   * The other half of "Change Payment Method": an order booked ONLINE that never got paid
   * (customer's payment failed/was abandoned) can switch to COD instead of being stuck
   * retrying the same gateway. Only valid before the order has ever been confirmed —
   * once paid, or once it's moved past PENDING_PAYMENT another way, this no longer applies.
   */
  async switchToCod(orderId: string, phone: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const ownerPhone = order.guestPhone;
    const owner = ownerPhone || (await this.prisma.user.findUnique({ where: { id: order.customerId }, select: { phone: true } }))?.phone;
    if (owner && owner !== phone) throw new ForbiddenException('Phone number does not match this order');
    if (order.paymentStatus === 'PAID') throw new BadRequestException('Order is already paid online');
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Order has already moved past payment — cannot switch to Cash on Delivery now');
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CONFIRMED, paymentMethod: 'COD' },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.CONFIRMED, note: 'Switched from Online to Cash on Delivery' });
    if (updated.serviceId) {
      this.dispatch.dispatch(updated.id).catch((e) => this.logger.error(`Dispatch failed: ${e.message}`));
    }
    return updated;
  }

  /**
   * Records that a COD order's payment was actually collected in person (cash/UPI/card) —
   * previously COD orders had no way to ever leave paymentStatus PENDING; it just stayed
   * PENDING forever with no reconciliation step. Callable by the assigned vendor or an admin.
   */
  async collectCod(
    actorUserId: string, actorRole: UserRole, orderId: string,
    mode: PaymentCollectionMode, collectedLocation?: string,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.paymentMethod === 'ONLINE') throw new BadRequestException('This order was paid online, not COD');
    if (order.paymentStatus === 'PAID') return order; // idempotent
    if (['CANCELLED', 'REFUNDED'].includes(order.status)) {
      throw new BadRequestException('Cannot collect payment for a cancelled/refunded order');
    }

    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    if (actorRole === UserRole.SERVICE_VENDOR) {
      const v = await this.prisma.serviceVendor.findUnique({ where: { userId: actorUserId } });
      if (!v || order.vendorId !== v.id) throw new ForbiddenException();
    } else if (!adminRoles.includes(actorRole)) {
      throw new ForbiddenException();
    }

    await this.prisma.paymentTransaction.create({
      data: {
        orderId, userId: order.customerId, amount: order.totalAmount, status: 'PAID',
        gateway: 'CASH_COLLECTION', collectionMode: mode,
        collectedBy: actorUserId, collectedLocation,
      },
    });
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'PAID', paymentMethod: 'COD' },
    });
    await writeOrderTimeline(this.prisma, {
      orderId, status: 'COD_PAYMENT_COLLECTED', actorId: actorUserId, actorRole,
      note: `Collected via ${mode}${collectedLocation ? ` at ${collectedLocation}` : ''}`,
    });
    return updated;
  }

  /**
   * The single source of truth for "how much is still owed" — Order.totalAmount already
   * absorbs extra-work amounts automatically (ExtraWorkService.recalc()), so balanceDue
   * recalculates correctly the moment extra work is approved, with no separate tracking
   * needed. Sums every successful PaymentTransaction for this order (original payment,
   * COD/balance collections, prior partial payments) plus any wallet amount applied at
   * booking time.
   */
  async getBalance(orderId: string, actorUserId?: string, actorRole?: UserRole) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundException('Order not found');
    // Ownership check only applies when called directly from a controller (actorUserId
    // passed in); collectBalance() already authorized the caller before delegating here.
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    const isAdmin = !!actorRole && adminRoles.includes(actorRole);
    if (actorUserId && !isAdmin && order.customerId !== actorUserId && order.vendor?.userId !== actorUserId) {
      throw new ForbiddenException();
    }
    const paidAgg = await this.prisma.paymentTransaction.aggregate({
      where: { orderId, status: 'PAID' },
      _sum: { amount: true },
    });
    const paidAmount = Number(paidAgg._sum.amount || 0);
    const walletUsed = Number(order.walletUsed || 0);
    const balanceDue = Math.max(0, Number(order.totalAmount) - paidAmount - walletUsed);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      walletUsed: order.walletUsed,
      paidAmount,
      balanceDue,
      paymentStatus: order.paymentStatus,
    };
  }

  /**
   * Collect any outstanding balance — the original amount for a still-unpaid order, or
   * whatever extra work added on top of an already-paid one. CASH/UPI/CARD is an in-person
   * collection (vendor or admin only); ONLINE generates a fresh gateway order that the
   * customer themselves, the vendor (handing over their device), or admin can trigger —
   * confirmBalancePayment() below finalizes it once the gateway signature verifies.
   */
  async collectBalance(actorUserId: string, actorRole: UserRole, orderId: string, mode: PaymentCollectionMode, collectedLocation?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (['CANCELLED', 'REFUNDED'].includes(order.status)) {
      throw new BadRequestException('Cannot collect payment for a cancelled/refunded order');
    }

    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    const isAdmin = adminRoles.includes(actorRole);
    const isOwner = order.customerId === actorUserId;
    const isAssignedVendor = order.vendor?.userId === actorUserId;
    if (mode === 'ONLINE') {
      if (!isAdmin && !isAssignedVendor && !isOwner) throw new ForbiddenException();
    } else if (!isAdmin && !isAssignedVendor) {
      throw new ForbiddenException();
    }

    const balance = await this.getBalance(orderId);
    if (balance.balanceDue <= 0) return { ...balance, message: 'Nothing due — already fully paid' };

    if (mode === 'ONLINE') {
      const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
      const payOrder: any = await this.payments.initiatePayment(order.customerId, balance.balanceDue, order.id, frontendUrl);
      return {
        orderId: order.id, orderNumber: order.orderNumber, balanceDue: balance.balanceDue,
        requiresPayment: true, gateway: payOrder.gateway, gatewayOrderId: payOrder.gatewayOrderId,
        razorpayKeyId: payOrder.keyId, txId: payOrder.txId,
      };
    }

    await this.prisma.paymentTransaction.create({
      data: {
        orderId, userId: order.customerId, amount: balance.balanceDue, status: 'PAID',
        gateway: 'CASH_COLLECTION', collectionMode: mode, collectedBy: actorUserId, collectedLocation,
      },
    });
    const updated = await this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } });
    await writeOrderTimeline(this.prisma, {
      orderId, status: 'BALANCE_COLLECTED', actorId: actorUserId, actorRole,
      note: `Collected ₹${balance.balanceDue} via ${mode}${collectedLocation ? ` at ${collectedLocation}` : ''}`,
    });
    return updated;
  }

  /**
   * Confirms an ONLINE balance/extra-work payment. Deliberately separate from
   * confirmPayment(): that method also drives the order's lifecycle status (PENDING_PAYMENT
   * -> CONFIRMED) which does not apply here — a balance payment can happen at ANY point after
   * the job is already COMPLETED/INVOICED, and must never move status backwards or sideways.
   */
  async confirmBalancePayment(orderId: string, paymentId: string, gatewayOrderId: string, signature: string) {
    if (!process.env.RAZORPAY_KEY_SECRET) throw new BadRequestException('Payment gateway not configured');
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${gatewayOrderId}|${paymentId}`)
      .digest('hex');
    if (expected !== signature) throw new BadRequestException('Invalid payment signature');

    const linkedTx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId, orderId } });
    if (!linkedTx) throw new BadRequestException('Payment does not belong to this order');
    if (linkedTx.status !== 'PAID') {
      await this.prisma.paymentTransaction.update({
        where: { id: linkedTx.id },
        data: { status: 'PAID', gatewayPaymentId: paymentId, gatewaySignature: signature },
      });
    }

    const balance = await this.getBalance(orderId);
    const newPaymentStatus = balance.balanceDue <= 0 ? 'PAID' : 'PARTIAL';
    return this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: newPaymentStatus } });
  }

  async markEnRoute(vendorUserId: string, orderId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const result = await this.prisma.order.updateMany({
      where: { id: orderId, vendorId: v.id },
      data: { status: OrderStatus.VENDOR_EN_ROUTE },
    });
    if (result.count > 0) {
      await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.VENDOR_EN_ROUTE, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    }
    return result;
  }

  async verifyStartOtp(vendorUserId: string, orderId: string, otp: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (order.status !== OrderStatus.VENDOR_EN_ROUTE) throw new BadRequestException('Order is not en-route');
    if (order.startOtp !== otp) throw new BadRequestException('Invalid OTP');
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { startOtpVerified: true, startedAt: new Date(), status: OrderStatus.STARTED },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.STARTED, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    return updated;
  }

  async complete(vendorUserId: string, orderId: string, otp: string, photosAfter: string[], videoUrl?: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (!['STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'].includes(order.status)) {
      throw new BadRequestException('Order cannot be completed at this stage');
    }
    // Completion OTP — same customer-hands-the-code-to-the-technician pattern as the start
    // OTP, so a job can't be marked done without the customer actually present/satisfied.
    // Orders created before this field existed have endOtp === null — skip the check for
    // those rather than permanently locking them out of completion.
    if (order.endOtp && order.endOtp !== otp) throw new BadRequestException('Invalid completion OTP');
    const completed = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.COMPLETED, completedAt: new Date(), photosAfter, videoUrl, endOtpVerified: !!order.endOtp },
    });
    await this.prisma.serviceVendor.update({
      where: { id: v.id },
      data: {
        completedJobs: { increment: 1 },
        totalEarnings: { increment: Number(order.vendorPayout) },
        pendingPayout: { increment: Number(order.vendorPayout) },
      },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.COMPLETED, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
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
    const count = await this.prisma.invoice.count();
    const b = computeInvoiceBreakdown({
      orderNumber: order.orderNumber,
      subtotal: Number(order.subtotal),
      totalAmount: Number(order.totalAmount),
      gstAmount: Number(order.gstAmount),
      serviceAmount: Number(order.serviceAmount),
      remontCommission: Number(order.remontCommission),
      approvedExtraWorkAmount: order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0),
    }, count);
    await this.prisma.invoice.create({ data: { orderId, ...b } });
    await this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.INVOICED } });
  }

  async myOrders(customerId: string, status?: OrderStatus) {
    return this.prisma.order.findMany({
      where: { customerId, ...(status ? { status } : {}) },
      include: {
        service: true, items: { include: { product: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        address: true, extraWorkItems: true, delivery: true,
        masterOrder: { select: { masterOrderNumber: true, totalAmount: true } },
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
        address: true, extraWorkItems: true, invoice: true, delivery: true,
      },
    });
    if (!order) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    return order;
  }

  /**
   * Customer-facing transaction history for the payment dashboard — deliberately strips
   * gatewaySignature/gatewayResponse (internal verification material) and only exposes
   * fields safe to show a customer: amount, when, status, gateway/collection mode.
   */
  async getPaymentHistory(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundException();
    if (order.customerId !== userId && order.vendor?.userId !== userId) throw new ForbiddenException();
    const transactions = await this.prisma.paymentTransaction.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, amount: true, status: true, gateway: true,
        collectionMode: true, failureReason: true, createdAt: true,
      },
    });
    return transactions;
  }

  async cancel(userId: string, orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerId !== userId) throw new ForbiddenException();
    if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(order.status)) {
      throw new BadRequestException('Cannot cancel at this stage');
    }
    const cancelled = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.CANCELLED, note: reason, actorId: userId, actorRole: UserRole.CUSTOMER });
    return cancelled;
  }
}

// ─── Guest Booking Service (no auth required) ───
@Injectable()
export class GuestBookingService {
  private readonly logger = new Logger(GuestBookingService.name);
  constructor(
    private prisma: PrismaService,
    private dispatch: DispatchService,
    private payments: PaymentsService,
    private cities: CitiesService,
  ) {}

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
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

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

    // COD confirms immediately (paymentStatus stays PENDING until an actual cash/UPI/card
    // collection is recorded — see collect-cod). ONLINE must NOT confirm here: the order
    // stays PENDING_PAYMENT and dispatch only fires once confirm-payment verifies the
    // gateway signature, below. Previously this method ignored paymentMethod entirely and
    // always auto-confirmed, so a customer choosing "Pay Online" in the booking modal was
    // silently booked without ever being charged.
    const isCOD = dto.paymentMethod !== 'ONLINE';
    const order = await this.prisma.order.create({
      data: {
        orderNumber,
        customerId: user.id,
        serviceId: dto.serviceId,
        addressId: address.id,
        type: OrderType.SERVICE,
        channel: dto.channel || BookingChannel.WEBSITE,
        status: isCOD ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT,
        paymentStatus: 'PENDING',
        paymentMethod: isCOD ? 'COD' : 'ONLINE',
        guestName: dto.name,
        guestPhone: dto.phone,
        guestEmail: dto.email || null,
        adminNotes: dto.notes || null,
        slotStart,
        slotEnd,
        startOtp,
        endOtp,
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

    if (isCOD) {
      this.logger.log(`📋 Guest booking (COD): ${orderNumber} for ${dto.name} (${dto.phone})`);
      this.dispatch.dispatch(order.id).catch((e) => this.logger.error(`Guest dispatch failed: ${e.message}`));
      return {
        orderNumber: order.orderNumber,
        orderId: order.id,
        status: order.status,
        paymentMethod: 'COD',
        service: order.service?.name,
        slot: slotStart.toISOString(),
        city: city.name,
        totalAmount: order.totalAmount,
        message: 'Booking confirmed! Our team will contact you within 30 minutes.',
      };
    }

    this.logger.log(`📋 Guest booking (ONLINE, pending payment): ${orderNumber} for ${dto.name} (${dto.phone})`);
    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    const payOrder: any = await this.payments.initiatePayment(user.id, totalAmount, order.id, frontendUrl);

    return {
      orderNumber: order.orderNumber,
      orderId: order.id,
      status: order.status,
      paymentMethod: 'ONLINE',
      requiresPayment: true,
      service: order.service?.name,
      slot: slotStart.toISOString(),
      city: city.name,
      totalAmount: order.totalAmount,
      gateway: payOrder.gateway,
      gatewayOrderId: payOrder.gatewayOrderId,
      razorpayKeyId: payOrder.keyId,
      redirectUrl: payOrder.redirectUrl,
      txId: payOrder.txId,
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

    if (dto.city) {
      const city = await this.cities.getByName(dto.city);
      if (city && !city.isActive) {
        throw new BadRequestException(`${city.name} is not currently accepting orders`);
      }
    }

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

    // Initiate payment via whichever gateway is active (configured in Admin → Payment Gateways)
    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    const payOrder = await this.payments.initiatePayment(user.id, totalAmount, order.id, frontendUrl);

    if (payOrder.gateway === 'PHONEPE') {
      return {
        orderNumber: order.orderNumber, orderId: order.id, totalAmount,
        paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
        gateway: 'PHONEPE',
        redirectUrl: (payOrder as any).redirectUrl,
        txId: (payOrder as any).txId,
      };
    }

    return {
      orderNumber: order.orderNumber, orderId: order.id, totalAmount,
      paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
      gateway: 'RAZORPAY',
      gatewayOrderId: (payOrder as any).gatewayOrderId,
      razorpayKeyId: (payOrder as any).keyId,
      txId: (payOrder as any).txId,
    };
  }

  async verifyPhonePeReturn(txId: string, dbOrderId: string) {
    const result = await this.payments.verifyPhonePePayment(txId);
    if (result.success) {
      const order = await this.prisma.order.findUnique({ where: { id: dbOrderId } });
      if (order && order.status === OrderStatus.PENDING_PAYMENT) {
        await this.prisma.order.update({
          where: { id: dbOrderId },
          data: { paymentId: result.paymentId, paymentStatus: 'PAID', status: OrderStatus.CONFIRMED },
        });
      }
      return { success: true, orderNumber: order?.orderNumber, message: 'Payment verified and order confirmed' };
    }
    return { success: false, state: result.state, message: 'Payment not completed or pending' };
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
      // Phone ownership already verified above — safe to hand back the OTPs the customer
      // reads out to the technician to confirm arrival/start and job completion.
      startOtp: order.startOtpVerified ? undefined : order.startOtp,
      endOtp: order.startOtpVerified && !order.endOtpVerified ? order.endOtp : undefined,
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
  @Post(':id/complete') complete(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { otp: string; photosAfter: string[]; videoUrl?: string }) {
    return this.orders.complete(u.sub, id, b.otp, b.photosAfter, b.videoUrl);
  }
  @Post(':id/collect-cod')
  collectCod(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { mode: PaymentCollectionMode; collectedLocation?: string },
  ) {
    return this.orders.collectCod(u.sub, u.role, id, b.mode, b.collectedLocation);
  }

  @Get(':id/balance') balance(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.orders.getBalance(id, u.sub, u.role);
  }

  @Get(':id/payment-history') paymentHistory(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.orders.getPaymentHistory(u.sub, id);
  }

  @Post(':id/collect-balance')
  collectBalance(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { mode: PaymentCollectionMode; collectedLocation?: string },
  ) {
    return this.orders.collectBalance(u.sub, u.role, id, b.mode, b.collectedLocation);
  }

  @Post(':id/confirm-balance-payment')
  confirmBalancePayment(
    @Param('id') id: string,
    @Body() b: { paymentId: string; gatewayOrderId: string; signature: string },
  ) {
    return this.orders.confirmBalancePayment(id, b.paymentId, b.gatewayOrderId, b.signature);
  }
}

// ─── Public (no-auth) booking controller ───
@ApiTags('Booking')
@Controller('orders/public')
export class PublicBookingController {
  constructor(private guest: GuestBookingService, private orders: OrdersService) {}

  @Post('book') book(@Body() dto: GuestBookingDto) { return this.guest.book(dto); }
  @Post('checkout') checkout(@Body() dto: PublicProductCheckoutDto) { return this.guest.publicProductCheckout(dto); }

  // Atomic verify+confirm for Razorpay guest checkout
  @Post('confirm-payment')
  confirmPayment(@Body() b: { dbOrderId: string; gatewayOrderId: string; paymentId: string; signature: string }) {
    return this.orders.confirmPayment(b.dbOrderId, b.paymentId, b.gatewayOrderId, b.signature);
  }

  // Retry a failed/abandoned payment, or convert an existing COD order to Online —
  // never creates a new order. Phone-verified since guests have no JWT.
  @Post(':id/retry-payment')
  retryPayment(@Param('id') id: string, @Body() b: { phone: string }) {
    return this.orders.retryPayment(id, b.phone);
  }

  // The reverse of retry-payment: an order booked Online that never got paid can
  // switch to Cash on Delivery instead of endlessly retrying the same gateway.
  @Post(':id/switch-to-cod')
  switchToCod(@Param('id') id: string, @Body() b: { phone: string }) {
    return this.orders.switchToCod(id, b.phone);
  }

  // PhonePe return callback — called by payment-return.html after redirect back from PhonePe
  @Get('verify-phonepe-return')
  async verifyPhonePeReturn(@Query('txId') txId: string, @Query('dbOrderId') dbOrderId: string) {
    return this.guest.verifyPhonePeReturn(txId, dbOrderId);
  }

  @Get('track/:orderNumber') track(@Param('orderNumber') num: string, @Query('phone') phone: string) {
    return this.guest.trackOrder(num, phone);
  }
}

@Module({
  imports: [CouponsModule, MembershipsModule, WhatsappModule, CitiesModule, PaymentsModule],
  controllers: [OrdersController, PublicBookingController],
  providers: [OrdersService, DispatchService, ExtraWorkService, GuestBookingService],
  exports: [OrdersService, DispatchService],
})
export class OrdersModule {}
