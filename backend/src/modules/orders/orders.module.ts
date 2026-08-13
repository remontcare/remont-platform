import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, OrderType, BookingChannel, UserRole, PaymentCollectionMode } from '@prisma/client';
import { IsString, IsOptional, IsEnum, IsArray, IsNumber, IsDateString, IsEmail, IsIn, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, haversineKm, writeOrderTimeline, computeInvoiceBreakdown, addressSnapshotFields, writeOtpLog, OTP_REGEN_COOLDOWN_SECONDS, resolveCommission, VENDOR_DISPATCHABLE_FULFILLMENT_TYPES, NOT_FROZEN_MEMBER_FILTER } from '../../common';
import { CouponsService, CouponsModule } from '../coupons/coupons.module';
import { MembershipsService, MembershipsModule } from '../memberships/memberships.module';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';

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
  constructor(private prisma: PrismaService, private events: EventEmitter2) {}

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
        ...NOT_FROZEN_MEMBER_FILTER, // excludes a frozen agency member; null (non-agency) vendors stay eligible
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
      // NotificationEngineModule's job-ring-policy.service.ts listens for this — it
      // handles the actual push/WhatsApp send (and the ring/retry policy), so this
      // module never imports the engine or WhatsappService directly.
      this.events.emit('job.offer.created', { vendorUserId: c.userId, orderId: order.id, order });
    }
    // Tracked regardless of whether any candidate was found — an empty wave (e.g. no
    // one live in that city right now) still needs lastDispatchedAt bumped so
    // DispatchRetryService's hourly sweep knows to try this order again later, and
    // still needs to surface in the admin "stuck orders" queue in the meantime.
    await this.prisma.order.update({
      where: { id: orderId },
      data: { dispatchAttempts: { increment: 1 }, lastDispatchedAt: new Date() },
    });
    this.logger.log(`📡 Dispatched ${order.orderNumber} to ${top.length} vendors`);
    return top;
  }
}

// ─── Dispatch retry sweep ───
// If a dispatch wave goes out and nobody accepts (all 5 candidates ignore/decline/expire),
// the order otherwise sits CONFIRMED with vendorId null forever — a vendor only ever finds
// it again by manually browsing "available jobs". This sweep re-dispatches a fresh wave
// (freshly-online vendors included) once an hour so the assignment keeps retrying on its
// own, matching the "keep cycling through live vendors" requirement — the admin "stuck
// orders" queue (see AdminService.listOrders `stuck` filter) is the parallel manual-override
// path for orders that need a human to just call someone directly.
@Injectable()
export class DispatchRetryService {
  private readonly logger = new Logger(DispatchRetryService.name);
  constructor(private prisma: PrismaService, private dispatch: DispatchService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep() {
    const stale = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.CONFIRMED,
        vendorId: null,
        // Explicit allowlist guard (not just "lastDispatchedAt is set/stale") — a
        // PROJECT/ADMIN_TEAM order also has lastDispatchedAt: null forever, since
        // RoutingService never calls dispatch() for it. Before this fix that was
        // incidentally safe only because a plain `lte` never matches NULL; now that we
        // explicitly catch the null case below too, this filter is what actually keeps
        // in-house orders out of the retry cycle.
        service: { fulfillmentType: { in: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } },
        // lastDispatchedAt: null must be caught explicitly — `lte` alone never matches a
        // NULL column in SQL (three-valued logic), so an order that somehow never got a
        // first dispatch wave (e.g. dispatchAttempts was backfilled to 0 by a migration
        // adding this column) would otherwise stay permanently invisible to this sweep.
        OR: [
          { lastDispatchedAt: null },
          { lastDispatchedAt: { lte: new Date(Date.now() - 60 * 60 * 1000) } },
        ],
      },
      select: { id: true, orderNumber: true },
      take: 100,
    });
    for (const o of stale) {
      await this.dispatch.dispatch(o.id).catch((err) => this.logger.error(`Retry-dispatch failed for ${o.orderNumber}: ${err.message}`));
    }
    if (stale.length) this.logger.log(`🔁 Re-dispatched ${stale.length} stuck order(s)`);
  }
}

// ─── Service assignment routing (Task 8) ───
// Runs once when an order/child-part is confirmed, based on Service.fulfillmentType:
//   PROJECT / ADMIN_TEAM  -> never auto-assigned, flagged for the admin queue instead.
//   DIRECT_PARTNER        -> auto-match ONLY an in-house staff member (an employee, who
//                            doesn't get to accept/reject the way a gig-partner does) by
//                            requiredSkills + order city; no in-house match (including
//                            "only partner candidates exist") falls back to the ring/
//                            notify/accept DispatchService flow every partner vendor goes
//                            through — never a silent direct-assign for a partner. (Was
//                            previously "in-house first, else best-rated partner,
//                            direct-assign either way" — that contradicted the
//                            vendor-must-accept requirement and, once the memberStatus
//                            null-exclusion bug elsewhere in this file was fixed, started
//                            actually firing for real partner vendors: no ring, no 30s
//                            notification, straight into VENDOR_ASSIGNED.)
// This never replaces the existing manual "Assign Vendor" admin action — it only
// pre-selects to save time; admins can always reassign afterward the same way they do today.
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  constructor(private prisma: PrismaService, private events: EventEmitter2, private dispatch: DispatchService) {}

  async route(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { service: true, address: true, customer: { select: { name: true, phone: true } } },
    });
    if (!order || !order.service) return; // product-only child orders have nothing to route

    const fulfillmentType = order.service.fulfillmentType || 'DIRECT_PARTNER';
    // Allowlist check (see VENDOR_DISPATCHABLE_FULFILLMENT_TYPES) — anything not
    // explicitly vendor-dispatchable goes to the admin queue instead, so a new
    // in-house-only FulfillmentType is safe-by-default without touching this file.
    if (!VENDOR_DISPATCHABLE_FULFILLMENT_TYPES.includes(fulfillmentType)) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { needsAdminReview: true, routingDecision: fulfillmentType },
      });
      this.logger.log(`📋 ${order.orderNumber} routed to admin queue (${fulfillmentType})`);
      return;
    }

    const cityName = order.address?.city || (order as any).snapshotCity || null;
    const requiredSkills: string[] = order.service.requiredSkills || [];
    const candidates = cityName ? await this.prisma.serviceVendor.findMany({
      where: {
        isOnline: true, status: 'ACTIVE', baseCity: cityName,
        ...NOT_FROZEN_MEMBER_FILTER, // excludes a frozen agency member; null (non-agency) vendors stay eligible
        ...(requiredSkills.length ? { skills: { hasSome: requiredSkills } } : {}),
      },
      include: { user: true },
      orderBy: { rating: 'desc' },
    }) : [];

    const chosen = candidates.find((v) => v.staffType === 'IN_HOUSE');

    if (chosen) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { vendorId: chosen.id, status: OrderStatus.VENDOR_ASSIGNED, routingDecision: 'IN_HOUSE' },
      });
      await writeOrderTimeline(this.prisma, {
        orderId, status: OrderStatus.VENDOR_ASSIGNED,
        note: `Auto-routed to in-house staff: ${chosen.fullName}`,
      });
      this.events.emit('job.offer.created', { vendorUserId: chosen.userId, orderId: order.id, order });
      return;
    }

    // No in-house match (whether or not partner candidates exist) — every partner vendor
    // goes through the ring/notify/accept flow, never a silent direct-assign. Flag it and
    // fall back to the existing multi-candidate notify flow.
    await this.prisma.order.update({ where: { id: orderId }, data: { routingDecision: 'MANUAL_FALLBACK' } });
    await this.dispatch.dispatch(orderId);
  }
}

// ─── Extra work service ───
@Injectable()
class ExtraWorkService {
  constructor(private prisma: PrismaService, private wa: WhatsappService, private paymentNotify: PaymentNotificationsService) {}

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
    const extra = await this.prisma.extraWorkItem.findUnique({ where: { id: extraId }, include: { order: { include: { customer: true } } } });
    if (!extra) throw new NotFoundException();
    if (extra.order.customerId !== customerId) throw new ForbiddenException();
    const updated = await this.prisma.extraWorkItem.update({
      where: { id: extraId },
      data: { customerApproved: true, approvedAt: new Date() },
    });
    await this.recalc(extra.orderId);
    // Additional-work approval increases the order's outstanding balance — let the
    // customer know right away rather than surprising them at completion time.
    this.paymentNotify.balanceDue(
      extra.order.customerId, extra.order.customer.phone, extra.order.orderNumber,
      Number(extra.amount), 'additional work approved', extra.orderId,
    ).catch(() => {});
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
    // Commission was already resolved once and snapshotted at confirmation time (Task 9) —
    // extra work changes the payout (more serviceAmount-equivalent to pay the vendor for)
    // but must NOT re-resolve commission rules again here, or a rule edited/removed after
    // booking could silently change what an already-placed order's invoice shows.
    const commission = Number(order.remontCommission);
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
    private routing: RoutingService,
    private cities: CitiesService,
    private payments: PaymentsService,
    private paymentNotify: PaymentNotificationsService,
    private ledger: PartnerLedgerService,
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
    let commissionResult = { commissionAmount: 0, ruleId: null as string | null, ruleLabel: 'No service on this order' };
    const itemInputs: any[] = [];

    if (dto.serviceId) {
      const svc = await this.prisma.service.findUnique({ where: { id: dto.serviceId } });
      if (!svc) throw new NotFoundException('Service not found');
      let cityRowId: string | null = null;
      // City-wise price override
      if (dto.city) {
        const cityPrice = await this.cities.getServicePrice(dto.city, svc.id);
        serviceAmount = cityPrice !== null ? cityPrice : Number(svc.basePrice);
        const cityRow = await this.cities.getByName(dto.city);
        cityRowId = cityRow?.id || null;
      } else {
        serviceAmount = Number(svc.basePrice);
      }
      commissionResult = await resolveCommission(this.prisma, {
        serviceId: svc.id, categoryId: svc.categoryId, cityId: cityRowId, amount: serviceAmount,
      });
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
    let resolvedAddress: Awaited<ReturnType<typeof this.prisma.address.findUnique>> = null;
    if (!resolvedAddressId && dto.inlineAddress) {
      resolvedAddress = await this.prisma.address.create({
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
      resolvedAddressId = resolvedAddress.id;
    } else if (resolvedAddressId) {
      // An existing saved address was selected — snapshot it as it is *right now*.
      // Later edits to this Address row must not retroactively change this order.
      resolvedAddress = await this.prisma.address.findUnique({ where: { id: resolvedAddressId } });
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
    const remontCommission = commissionResult.commissionAmount;
    const vendorPayout = serviceAmount - remontCommission;

    const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const order = await this.prisma.order.create({
      data: {
        orderNumber, customerId,
        type: dto.type, channel: dto.channel || BookingChannel.WEBSITE,
        serviceId: dto.serviceId, addressId: resolvedAddressId,
        ...addressSnapshotFields(resolvedAddress),
        slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
        slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
        startOtp, endOtp, status: OrderStatus.PENDING_PAYMENT,
        serviceAmount, productsAmount, subtotal,
        couponCode: dto.couponCode, couponDiscount, membershipDiscount,
        walletUsed, gstAmount, totalAmount, remontCommission, vendorPayout,
        commissionRuleId: commissionResult.ruleId, commissionRuleLabel: commissionResult.ruleLabel,
        aiSessionId: dto.aiSessionId, leadId: dto.leadId,
        guestName: dto.guestName,
        guestPhone: dto.guestPhone,
        items: itemInputs.length ? { create: itemInputs } : undefined,
      },
      include: { items: true, service: true, address: true },
    });

    await writeOtpLog(this.prisma, { orderId: order.id, otpType: 'START', otp: startOtp, action: 'GENERATED', requestedByRole: 'SYSTEM' });
    await writeOtpLog(this.prisma, { orderId: order.id, otpType: 'END', otp: endOtp, action: 'GENERATED', requestedByRole: 'SYSTEM' });

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
      this.routing.route(order.id).catch((e) => this.logger.error(`Routing failed: ${e.message}`));
    }
    this.notifyPaymentSuccess(order).catch(() => {});
    return order;
  }

  /** Resolves the right phone (guest or registered) and fires the payment-success notification. */
  private async notifyPaymentSuccess(order: { id: string; customerId: string; guestPhone: string | null; orderNumber: string; totalAmount: any }) {
    const phone = order.guestPhone || (await this.prisma.user.findUnique({ where: { id: order.customerId }, select: { phone: true } }))?.phone;
    if (!phone) return;
    await this.paymentNotify.paymentSuccess(order.customerId, phone, order.orderNumber, Number(order.totalAmount), order.id);
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
    // Service-level payment restriction (admin-configurable, Service.paymentMode) — this
    // always ends up charging Online (fresh retry or COD→Online conversion alike), so a
    // Cash-on-Delivery-only service must never reach the gateway here, same as switchToCod()
    // blocks the opposite direction for an Online-only service.
    if (order.serviceId) {
      const svc = await this.prisma.service.findUnique({ where: { id: order.serviceId }, select: { name: true, paymentMode: true } });
      if (svc?.paymentMode === 'COD_ONLY') {
        throw new BadRequestException(`${svc.name} is Cash on Delivery only — online payment isn't available for this service.`);
      }
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
    // Service-level payment restriction (admin-configurable, Service.paymentMode) — the
    // single source of truth both the website and the app read; re-checked here so a
    // stale client UI can never actually force COD through on a since-restricted service.
    if (order.serviceId) {
      const svc = await this.prisma.service.findUnique({ where: { id: order.serviceId }, select: { name: true, paymentMode: true } });
      if (svc?.paymentMode === 'ONLINE_ONLY') {
        throw new BadRequestException(`${svc.name} requires online payment — Cash on Delivery isn't available for this service.`);
      }
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CONFIRMED, paymentMethod: 'COD' },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.CONFIRMED, note: 'Switched from Online to Cash on Delivery' });
    if (updated.serviceId) {
      this.routing.route(updated.id).catch((e) => this.logger.error(`Routing failed: ${e.message}`));
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
    this.notifyPaymentSuccess(updated).catch(() => {});
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
    this.notifyPaymentSuccess(updated).catch(() => {});
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
    const updated = await this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: newPaymentStatus } });
    if (newPaymentStatus === 'PAID') this.notifyPaymentSuccess(updated).catch(() => {});
    return updated;
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
    await writeOtpLog(this.prisma, { orderId, otpType: 'START', otp, action: 'VERIFIED', requestedByRole: 'VENDOR', requestedById: v.id });
    return updated;
  }

  async complete(vendorUserId: string, orderId: string, otp: string, photosAfter: string[], videoUrl?: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { service: { include: { category: true } } },
    });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (!['STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'].includes(order.status)) {
      throw new BadRequestException('Order cannot be completed at this stage');
    }
    // Completion OTP — same customer-hands-the-code-to-the-technician pattern as the start
    // OTP, so a job can't be marked done without the customer actually present/satisfied.
    // Orders created before this field existed have endOtp === null — skip the check for
    // those rather than permanently locking them out of completion.
    if (order.endOtp && order.endOtp !== otp) throw new BadRequestException('Invalid completion OTP');

    // Vendor Wallet true-up: Lead Cost was already deducted in full at accept time as an
    // advance against this job's commission (see ServiceVendorsService.acceptJob) — only the
    // remainder of the commission is collected here. Reconstructing the gross amount from
    // vendorPayout+remontCommission (both already fully resolved, including any approved
    // extra work via ExtraWorkService.recalc()) avoids re-deriving totals from scratch.
    // When leadCostAmount is 0 (every order that predates this feature, or if it's ever
    // disabled) this reduces exactly to remainingCommission=fullCommission and
    // completionCredit=vendorPayout — byte-identical to the pre-existing behavior.
    const fullCommission = Number(order.remontCommission);
    const leadCostPaid = Number(order.leadCostAmount);
    const remainingCommission = Math.max(0, fullCommission - leadCostPaid);
    const grossAmount = Number(order.vendorPayout) + fullCommission;
    const completionCredit = grossAmount - remainingCommission; // == vendorPayout + leadCostPaid

    const { days, percent } = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
    const holdAmount = percent > 0 ? Math.round(completionCredit * percent) / 100 : 0;
    const releasedNow = completionCredit - holdAmount;

    // Job-completion → ledger update is Phase 2's "Settlement Engine" backbone: previously
    // the order update and the ServiceVendor earnings update were two separate, non-atomic
    // writes — wrapping them (plus the new ledger entries) in one $transaction closes that gap.
    //
    // Race condition fix: the status check above reads `order` outside any lock — two
    // concurrent completion requests (a flaky-connection double-tap, a client retry) could
    // both pass that check before either commits, and both would then post a full
    // JOB_EARNING/COMMISSION/HOLD sequence for the same job — double-paying the vendor. The
    // conditional updateMany() below re-checks the status atomically inside the transaction
    // (only one concurrent caller's WHERE can match), exactly mirroring the order-claim lock
    // in ServiceVendorsService.acceptJob() — every ledger/balance write that follows only
    // runs for whichever request actually won the count===1 check.
    const completed = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: { in: ['STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'] } },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date(), photosAfter, videoUrl, endOtpVerified: !!order.endOtp },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Order cannot be completed at this stage');
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      await tx.serviceVendor.update({
        where: { id: v.id },
        data: {
          completedJobs: { increment: 1 },
          totalEarnings: { increment: Number(order.vendorPayout) }, // unchanged formula/timing — lifetime-gross metric
          pendingPayout: { increment: releasedNow },
        },
      });
      await this.ledger.postEntry(tx, v.id, 'JOB_EARNING', grossAmount, { orderId });
      await this.ledger.trueUpCommission(tx, v.id, orderId, remainingCommission);
      if (holdAmount > 0) {
        const releaseDueAt = new Date();
        releaseDueAt.setDate(releaseDueAt.getDate() + days);
        await this.ledger.postHold(tx, v.id, 'WARRANTY_HOLD', holdAmount, { orderId, releaseDueAt });
      }
      return updated;
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.COMPLETED, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    if (order.endOtp) {
      await writeOtpLog(this.prisma, { orderId, otpType: 'END', otp, action: 'VERIFIED', requestedByRole: 'VENDOR', requestedById: v.id });
    }
    this.autoGenerateInvoice(orderId).catch((e) => this.logger.warn(`Auto-invoice failed: ${e.message}`));
    this.notifyWorkCompleted(completed).catch(() => {});
    return completed;
  }

  private async notifyWorkCompleted(order: { id: string; customerId: string; guestPhone: string | null; orderNumber: string }) {
    const phone = order.guestPhone || (await this.prisma.user.findUnique({ where: { id: order.customerId }, select: { phone: true } }))?.phone;
    if (!phone) return;
    await this.paymentNotify.workCompleted(order.customerId, phone, order.orderNumber, order.id);
  }

  /**
   * "Request OTP Again" — the assigned vendor regenerates the start or completion OTP
   * for THIS order only (never touches any other child order under the same master
   * order, so a multi-service booking's other partners are unaffected). Overwriting
   * order.startOtp/endOtp makes the previous code invalid immediately, since every OTP
   * check reads that same live field. A full history survives regardless, in
   * OrderOtpLog (never mutated, append-only).
   */
  async regenerateOtp(vendorUserId: string, orderId: string, type: 'START' | 'END') {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();

    const isStart = type === 'START';
    if (isStart) {
      if (order.startOtpVerified) throw new BadRequestException('Start OTP already verified for this service');
    } else {
      // Mirrors the existing lifecycle gate in complete(): a completion OTP only makes
      // sense once this specific partner has actually started the job.
      if (!order.startOtpVerified) throw new BadRequestException('Job has not started yet — completion OTP is not active');
      if (order.endOtpVerified) throw new BadRequestException('Completion OTP already verified for this service');
    }

    const lastSentAt = isStart ? order.startOtpLastSentAt : order.endOtpLastSentAt;
    if (lastSentAt) {
      const secsSince = (Date.now() - lastSentAt.getTime()) / 1000;
      if (secsSince < OTP_REGEN_COOLDOWN_SECONDS) {
        throw new BadRequestException(`Please wait ${Math.ceil(OTP_REGEN_COOLDOWN_SECONDS - secsSince)}s before requesting another OTP`);
      }
    }

    // 0/unset = unlimited, matching the requirement's "unlimited (or configurable limit
    // from Admin Panel)" — admins set this via the existing generic Site Settings screen.
    const limitSetting = await this.prisma.siteSetting.findUnique({ where: { key: 'otp_regen_max_attempts' } });
    const maxAttempts = limitSetting ? parseInt(limitSetting.value, 10) || 0 : 0;
    if (maxAttempts > 0) {
      const usedCount = await this.prisma.orderOtpLog.count({ where: { orderId, otpType: type, action: 'REGENERATED' } });
      if (usedCount >= maxAttempts) {
        throw new BadRequestException(`Maximum OTP resend limit (${maxAttempts}) reached for this service`);
      }
    }

    const newOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const now = new Date();
    await this.prisma.order.update({
      where: { id: orderId },
      data: isStart ? { startOtp: newOtp, startOtpLastSentAt: now } : { endOtp: newOtp, endOtpLastSentAt: now },
    });
    await writeOtpLog(this.prisma, { orderId, otpType: type, otp: newOtp, action: 'REGENERATED', requestedByRole: 'VENDOR', requestedById: v.id });

    const phone = order.guestPhone || (await this.prisma.user.findUnique({ where: { id: order.customerId }, select: { phone: true } }))?.phone;
    if (phone) {
      this.paymentNotify.otpResent(order.customerId, phone, order.orderNumber, type, newOtp, order.id).catch(() => {});
    }

    return { orderId, otpType: type, sentAt: now };
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
        serviceItems: { include: { service: true } },
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
        serviceItems: { include: { service: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        address: true, extraWorkItems: true, invoice: true, delivery: true,
        timeline: { orderBy: { createdAt: 'asc' } },
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
    // Customer-initiated cancellation refunds any Lead Cost already charged to the assigned
    // vendor — per spec, only a vendor-side drop (rejectJob) forfeits it.
    //
    // Race condition fix: `order` above is a stale read taken before the transaction opens —
    // two concurrent cancel attempts (a double-tap, or this racing AdminService's own
    // adminCancelOrder() for the same order) could both see leadCostRefunded:false and both
    // refund. The updateMany() below is a compare-and-swap on that exact flag: only the
    // request whose WHERE actually matches (count===1) proceeds to credit the ledger — the
    // same conditional-update idiom as ServiceVendorsService.acceptJob()'s claim lock.
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason },
      });
      if (order.vendorId && Number(order.leadCostAmount) > 0) {
        const claimed = await tx.order.updateMany({
          where: { id: orderId, leadCostRefunded: false },
          data: { leadCostRefunded: true },
        });
        if (claimed.count === 1) {
          await this.ledger.refundLeadCost(tx, order.vendorId, orderId, Number(order.leadCostAmount));
          await tx.serviceVendor.update({ where: { id: order.vendorId }, data: { pendingPayout: { increment: Number(order.leadCostAmount) } } });
        }
      }
      return updated;
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
    private routing: RoutingService,
    private payments: PaymentsService,
    private cities: CitiesService,
    private paymentNotify: PaymentNotificationsService,
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
    // Service-level payment restriction (admin-configurable, Service.paymentMode) —
    // mirrors the check in switchToCod()/MasterOrdersService.checkout() so this is
    // enforced identically no matter which booking path (website quick-book, website
    // cart, or the app) the customer came through.
    if (svc.paymentMode === 'ONLINE_ONLY' && dto.paymentMethod !== 'ONLINE') {
      throw new BadRequestException(`${svc.name} requires online payment — Cash on Delivery isn't available for this service.`);
    }
    if (svc.paymentMode === 'COD_ONLY' && dto.paymentMethod === 'ONLINE') {
      throw new BadRequestException(`${svc.name} is Cash on Delivery only — online payment isn't available for this service.`);
    }

    // Verify city
    const city = await this.prisma.city.findUnique({ where: { id: dto.cityId } });
    if (!city || !city.isActive) throw new NotFoundException('City not available');

    // Determine price: per-service city override → else city priceMultiplier on
    // basePrice → else basePrice as-is (CitiesService.getServicePrice — shared with
    // the authenticated create() and Master Order checkout price resolution).
    const cityPrice = await this.cities.getServicePrice(city.name, dto.serviceId);
    const serviceAmount = cityPrice !== null ? cityPrice : Number(svc.basePrice);
    const commissionResult = await resolveCommission(this.prisma, {
      serviceId: svc.id, categoryId: svc.categoryId, cityId: city.id, amount: serviceAmount,
    });

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
        ...addressSnapshotFields(address),
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
        remontCommission: commissionResult.commissionAmount,
        vendorPayout: serviceAmount - commissionResult.commissionAmount,
        commissionRuleId: commissionResult.ruleId,
        commissionRuleLabel: commissionResult.ruleLabel,
      },
      include: {
        service: { select: { name: true, durationMinutes: true } },
        address: true,
        customer: { select: { name: true, phone: true } },
      },
    });

    await writeOtpLog(this.prisma, { orderId: order.id, otpType: 'START', otp: startOtp, action: 'GENERATED', requestedByRole: 'SYSTEM' });
    await writeOtpLog(this.prisma, { orderId: order.id, otpType: 'END', otp: endOtp, action: 'GENERATED', requestedByRole: 'SYSTEM' });

    if (isCOD) {
      this.logger.log(`📋 Guest booking (COD): ${orderNumber} for ${dto.name} (${dto.phone})`);
      this.routing.route(order.id).catch((e) => this.logger.error(`Guest routing failed: ${e.message}`));
      // One-time nudge encouraging online payment — "throughout the application encourage
      // online payment" per the COD workflow requirement.
      this.paymentNotify.payOnlineNudge(user.id, dto.phone, order.orderNumber, order.id).catch(() => {});
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
        ...addressSnapshotFields(address),
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
  @Post(':id/regenerate-otp') regenerateOtp(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { type: 'START' | 'END' }) {
    return this.orders.regenerateOtp(u.sub, id, b.type);
  }
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
  imports: [CouponsModule, MembershipsModule, WhatsappModule, CitiesModule, PaymentsModule, PaymentNotificationsModule, PartnerLedgerModule],
  controllers: [OrdersController, PublicBookingController],
  providers: [OrdersService, DispatchService, RoutingService, ExtraWorkService, GuestBookingService, DispatchRetryService],
  exports: [OrdersService, DispatchService, RoutingService],
})
export class OrdersModule {}
