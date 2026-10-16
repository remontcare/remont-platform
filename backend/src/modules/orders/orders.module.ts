import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger, Optional, InternalServerErrorException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, OrderType, BookingChannel, UserRole, PaymentCollectionMode, MediaEntityType } from '@prisma/client';
import { IsString, IsOptional, IsEnum, IsArray, IsNumber, IsBoolean, IsDateString, IsEmail, IsIn, Min, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, haversineKm, isValidIndiaCoords, LOCATION_STALE_AFTER_MS, MAX_DISPATCH_RADIUS_KM, boundingBoxForRadius, normalizeSkillKey, writeOrderTimeline, addressSnapshotFields, writeOtpLog, OTP_REGEN_COOLDOWN_SECONDS, resolveCommission, priceServiceBooking, buildServiceTaxResolver, SERVICE_GST_FALLBACK_RATE, recordPartnerArrival, resolveCityIdForRules, resolveProductFee, resolveProductGstLine, buildTaxRateResolver, PLATFORM_FEE_DEFAULT_RATE, VENDOR_DISPATCHABLE_FULFILLMENT_TYPES, NOT_FROZEN_MEMBER_FILTER, applySellerFundedDiscountToProductGst, buildDiscountAllocationData, reserveProductStock, releaseUnpaidOrderWallet, logAudit, serviceBookingGst, recalculateMarketplaceOrder, isValidGstinFormat } from '../../common';
import { CouponsService, CouponsModule } from '../coupons/coupons.module';
import { MembershipsService, MembershipsModule } from '../memberships/memberships.module';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';
import { InvoicesService, InvoicesModule } from '../invoices/invoices.module';
import { ReturnsService, ReturnsModule } from '../returns/returns.module';
import { MediaModule } from '../media/media.module';
import { MediaService, PublicMedia } from '../media/media.service';
import { isInlineImage } from '../media/media.policy';

/** Upper bound on completion photos per job — each one is virus-scanned and uploaded. */
const MAX_COMPLETION_PHOTOS = 20;

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
  @IsOptional() @IsString() idempotencyKey?: string;
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
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsDateString() slotDate: string;
  @IsString() slotTime: string; // e.g. "10:00", "14:00", "18:00"
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(BookingChannel) channel?: BookingChannel;
  // Defaults to COD for older/other clients that don't send it yet — matches the
  // pre-existing behavior this field's absence used to (silently) produce.
  @IsOptional() @IsIn(['ONLINE', 'COD']) paymentMethod?: 'ONLINE' | 'COD';
  // Phase 8 (M-06) — this guest SERVICE booking path was the one remaining order-creation
  // path with no idempotency support at all (CreateOrderDto/PublicProductCheckoutDto/
  // CreateMasterOrderDto all already have this — see their matching M-06 comments).
  // Optional/opt-in: omitted entirely is byte-for-byte today's behaviour.
  @IsOptional() @IsString() idempotencyKey?: string;
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
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
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
  // Phase 1 hardening (M-06) — optional client-supplied dedupe token; see
  // MasterOrder.idempotencyKey's schema comment for the full rationale. Omitted entirely,
  // this is byte-for-byte today's behaviour.
  @IsOptional() @IsString() idempotencyKey?: string;
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
    // ServiceCategory.key is stored however an admin typed it when the category was
    // created (e.g. "plumbing", lowercase, per the seed data) — every vendor's own
    // skills array is normalized to normalizeSkillKey() form (e.g. "PLUMBING") at
    // registration time. Without normalizing here too, `skills: { has: skill }` below
    // is a case-sensitive array match that NEVER matches any vendor, for any category,
    // in any city — the root cause of automatic dispatch silently finding zero
    // candidates even when a perfectly eligible vendor is online right next door.
    const skill = normalizeSkillKey(order.service.category.key);
    const hasOrderCoords = isValidIndiaCoords(lat, lng);
    // Service model: a MARKETPLACE job is offered only to external partners, an IN_HOUSE job only to
    // Remont's own technicians (legacy orders: anyone, as before).
    const staffFilter = order.serviceModel === 'MARKETPLACE' ? { staffType: 'PARTNER' as const } : order.serviceModel === 'IN_HOUSE' ? { staffType: 'IN_HOUSE' as const } : {};

    // Production incident: a verified, ACTIVE, online, correct-skill, same-city vendor
    // (Mayank, Bhopal, WATERPROOFING) never received an order with valid GPS coordinates,
    // because he has never sent a single location ping (currentLatitude is null — the app
    // never called PATCH .../me/location for him). The old code picked EITHER the GPS-radius
    // branch OR the city-text-fallback branch based only on whether the ORDER had valid
    // coordinates — an order with valid GPS always took the GPS-only branch, which
    // structurally excludes every vendor with no location fix, even ones in the exact right
    // city. Fixed by treating the two pools as ADDITIVE, not either/or: real GPS-radius
    // matches (scored by actual distance) plus same-city vendors who simply have no usable
    // GPS fix yet (scored by the same city-fallback formula) — matching the priority-tier
    // business rule (nearest verified partner first, same-city-no-GPS next, never silently
    // dropped just because a phone never granted location permission).
    const candidatesByVendorId = new Map<string, any>();

    if (hasOrderCoords) {
      // Scale fix: narrow to a geographically plausible candidate set at the DB level
      // FIRST (a generous bounding box no real eligible vendor can fall outside of, since
      // no vendor can configure a serviceRadius above MAX_DISPATCH_RADIUS_KM) before pulling
      // rows into the app for the exact haversineKm+per-vendor-radius check below. Without
      // this, "take: 50, no geographic filter" meant the real nearest vendor could simply
      // never be among the 50 rows fetched once the nationwide online-vendor count grew
      // past that — see ServiceVendor(currentLatitude, currentLongitude) index.
      const box = boundingBoxForRadius(lat, lng, MAX_DISPATCH_RADIUS_KM);
      const vendors = await this.prisma.serviceVendor.findMany({
        where: {
          isOnline: true, status: 'ACTIVE',
          skills: { has: skill },
          ...staffFilter,
          currentLatitude: { gte: box.minLat, lte: box.maxLat },
          currentLongitude: { gte: box.minLng, lte: box.maxLng },
          lastLocationUpdate: { gte: new Date(Date.now() - LOCATION_STALE_AFTER_MS) },
          ...NOT_FROZEN_MEMBER_FILTER, // excludes a frozen agency member; null (non-agency) vendors stay eligible
        },
        include: { user: true },
        take: 200,
      });
      for (const v of vendors) {
        const d = haversineKm(lat, lng, v.currentLatitude!, v.currentLongitude!);
        if (d > v.serviceRadius) continue;
        const score = (v.rating / 5) * 50 + Math.max(0, 50 - d * 5) + (v.isVipPro ? 10 : 0);
        candidatesByVendorId.set(v.id, { vendorId: v.id, userId: v.userId, distance: d, rating: v.rating, score });
      }
    }

    if (order.address.city) {
      // Same-city fallback pool — additive to the GPS pool above, not a replacement for it.
      // Deliberately excludes any vendor with a fresh, valid GPS fix: that vendor's real
      // distance (checked above) is more precise than a same-city guess, so if they weren't
      // already added above it's because they're genuinely too far right now, not because
      // this branch never ran.
      const vendors = await this.prisma.serviceVendor.findMany({
        where: {
          isOnline: true, status: 'ACTIVE',
          skills: { has: skill },
          ...staffFilter,
          baseCity: { equals: order.address.city, mode: 'insensitive' },
          ...NOT_FROZEN_MEMBER_FILTER,
          OR: [
            { currentLatitude: null }, { currentLongitude: null },
            { lastLocationUpdate: null }, { lastLocationUpdate: { lt: new Date(Date.now() - LOCATION_STALE_AFTER_MS) } },
          ],
        },
        include: { user: true },
        take: 50,
      });
      for (const v of vendors) {
        if (candidatesByVendorId.has(v.id)) continue;
        candidatesByVendorId.set(v.id, {
          vendorId: v.id, userId: v.userId, distance: null, rating: v.rating,
          score: (v.rating / 5) * 50 + (v.isVipPro ? 10 : 0),
        });
      }
    }

    const candidates = Array.from(candidatesByVendorId.values());
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
    // Same normalization gap as DispatchService.dispatch()'s `skill` — Service.requiredSkills
    // is stored however an admin typed/selected it, while every vendor's skills array is
    // always normalizeSkillKey()-normalized at registration.
    const requiredSkills: string[] = (order.service.requiredSkills || []).map(normalizeSkillKey);
    const candidates = cityName ? await this.prisma.serviceVendor.findMany({
      where: {
        isOnline: true, status: 'ACTIVE',
        // case-insensitive — matches the same city comparison ServiceVendorsService's
        // isEligibleForOrder() fallback already uses (.toLowerCase() on both sides), so a
        // vendor isn't skipped here just because "Bhopal" vs "bhopal" don't match exactly
        baseCity: { equals: cityName, mode: 'insensitive' },
        ...NOT_FROZEN_MEMBER_FILTER, // excludes a frozen agency member; null (non-agency) vendors stay eligible
        ...(requiredSkills.length ? { skills: { hasSome: requiredSkills } } : {}),
      },
      include: { user: true },
      orderBy: { rating: 'desc' },
    }) : [];

    // Service model (frozen on the order from its category): a MARKETPLACE job goes only to external
    // partners, an IN_HOUSE job only to Remont's own technicians. Legacy orders: in-house first.
    const chosen = order.serviceModel === 'MARKETPLACE' ? undefined : candidates.find((v) => v.staffType === 'IN_HOUSE');
    if (!chosen && order.serviceModel === 'IN_HOUSE') {
      await this.prisma.order.update({ where: { id: orderId }, data: { needsAdminReview: true, routingDecision: 'IN_HOUSE_UNAVAILABLE' } });
      await writeOrderTimeline(this.prisma, { orderId, status: order.status, note: 'No in-house technician available — sent to the admin queue (in-house service)' });
      this.logger.log('📋 ' + order.orderNumber + ' in-house service, no in-house technician online — admin queue');
      return;
    }

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

  async requestOtp(vendorUserId: string, orderId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!vendor) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
    if (!order) throw new NotFoundException();
    if (order.vendorId !== vendor.id) throw new ForbiddenException();
    if (!['STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'].includes(order.status)) {
      throw new BadRequestException('Cannot confirm extras at this stage');
    }
    const pending = await this.prisma.extraWorkItem.findFirst({
      where: { orderId, customerApproved: false },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) throw new NotFoundException('No pending extra work item for this order');

    if (pending.otpLastSentAt) {
      const secsSince = (Date.now() - pending.otpLastSentAt.getTime()) / 1000;
      if (secsSince < OTP_REGEN_COOLDOWN_SECONDS) {
        throw new BadRequestException(`Please wait ${Math.ceil(OTP_REGEN_COOLDOWN_SECONDS - secsSince)}s before requesting another OTP`);
      }
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const now = new Date();
    await this.prisma.extraWorkItem.update({ where: { id: pending.id }, data: { otp, otpLastSentAt: now } });
    await this.prisma.order.update({ where: { id: orderId }, data: { extraOtpFailedAttempts: 0 } });
    const phone = order.guestPhone || order.customer.phone;
    if (phone) {
      this.wa.sendExtraWorkOtp(phone, order.orderNumber, otp).catch(() => {});
    }
    return { extraWorkItemId: pending.id, sentAt: now };
  }

  async verifyOtp(vendorUserId: string, orderId: string, otp: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!vendor) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException();
    if (order.vendorId !== vendor.id) throw new ForbiddenException();

    const slot = await this.prisma.order.updateMany({ where: { id: orderId, extraOtpFailedAttempts: { lt: OTP_MAX_FAILED_ATTEMPTS } }, data: { extraOtpFailedAttempts: { increment: 1 } } });
    if (slot.count !== 1) throw new BadRequestException('Too many wrong OTP attempts — send the customer a new extra-work OTP');
    const pending = otp ? await this.prisma.extraWorkItem.findFirst({
      where: { orderId, customerApproved: false, otp },
      orderBy: { createdAt: 'desc' },
    }) : null;
    if (!pending) throw new BadRequestException('Invalid OTP');
    await this.prisma.order.update({ where: { id: orderId }, data: { extraOtpFailedAttempts: 0 } });

    const updated = await this.prisma.extraWorkItem.update({
      where: { id: pending.id },
      data: { otpVerified: true, customerApproved: true, approvedAt: new Date() },
    });
    await this.recalc(orderId);
    return updated;
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
    // Partner marketplace: GST on the fee + partner share (+ the partner's GST if registered).
    if (await recalculateMarketplaceOrder(this.prisma, orderId)) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { extraWorkItems: { where: { customerApproved: true } }, service: true },
    });
    if (!order) return;
    const extraTotal = order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
    const subtotal = Number(order.serviceAmount) + Number(order.productsAmount) + extraTotal;
    const svcRate = order.service
      ? (await buildServiceTaxResolver(this.prisma)).rateFor(order.service.hsnSac, order.service.gstOverridePercent)
      : SERVICE_GST_FALLBACK_RATE;
    // In-house: Remont's own supply, GST on the discounted value (as at checkout). Legacy orders keep
    // their original formula unchanged.
    const priceDiscount = Number(order.couponDiscount) + Number(order.membershipDiscount) + Number(order.bundleDiscountAmount || 0);
    const gst = order.serviceModel === 'IN_HOUSE'
      ? Math.round(Math.max(0, subtotal - priceDiscount) * (svcRate / 100) * 100) / 100
      : Math.round(subtotal * (svcRate / 100) * 100) / 100;
    const discount = (order.serviceModel === 'IN_HOUSE' ? priceDiscount : Number(order.couponDiscount) + Number(order.membershipDiscount)) + Number(order.walletUsed);
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

/** Partner "I have arrived". All optional: a GPS failure is reported via locationError, never
 * with made-up coordinates; the server decides verification (recordPartnerArrival). */
export class PartnerArrivalDto {
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsNumber() @Min(0) accuracyM?: number;
  @IsOptional() @IsString() @MaxLength(200) locationError?: string;
  // Device metadata (optional; untrusted — can only downgrade verification, never upgrade it)
  @IsOptional() @IsBoolean() isMocked?: boolean;
  @IsOptional() @IsNumber() @Min(0) fixAgeMs?: number;
}
// ─── Main Orders service ───
/** Wrong start/completion/extra-work OTP guesses allowed before a new code must be sent. */
export const OTP_MAX_FAILED_ATTEMPTS = 5;
/** A re-sent start/completion OTP is valid for this long (the booking-time code has no expiry). */
export const OTP_RESENT_VALIDITY_MS = 15 * 60 * 1000;
const r2m = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** A cash collection is "verified" only by one of these — never by the partner's own report. */
type CashVerification = 'COMPLETION_OTP' | 'CUSTOMER' | 'ADMIN';

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
    private invoices: InvoicesService,
    private returns: ReturnsService,
    @Optional() private media?: MediaService,
  ) {}

  /**
   * The single pricing path for create() and quote(): service price (city override, minimum
   * charge, shared GST rate, commission), product GST/fees, membership/coupon discounts, GST and
   * wallet. Writes nothing — so the app's quote is exactly what create() then charges.
   */
  private async priceOrder(customerId: string, dto: CreateOrderDto) {
    let serviceAmount = 0;
    let productsAmount = 0;
    let commissionResult = { commissionAmount: 0, ruleId: null as string | null, ruleLabel: 'No service on this order' };
    let serviceGstRatePercent = SERVICE_GST_FALLBACK_RATE;
    let minimumChargeAdjustment = 0;
    let minimumChargeRuleId: string | null = null;
    let serviceCategory: { serviceModel?: string | null; gstSection95Status?: string | null } | null = null;
    const itemInputs: any[] = [];

    if (dto.serviceId) {
      const svc = await this.prisma.service.findUnique({ where: { id: dto.serviceId }, include: { category: { select: { serviceModel: true, gstSection95Status: true } } } });
      if (!svc) throw new NotFoundException('Service not found');
      serviceCategory = (svc as any).category;
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
      // Rules need the booking's city even when the client sends no city name (the app never
      // does): take it from the customer's own address. Unrecognised → all-city rules only.
      if (!cityRowId) {
        cityRowId = await resolveCityIdForRules(this.prisma, { addressId: dto.addressId, customerId, inlineCity: dto.inlineAddress?.city });
      }
      const priced = await priceServiceBooking(this.prisma, svc, cityRowId, serviceAmount);
      serviceAmount = priced.serviceAmount;
      commissionResult = priced.commissionResult;
      serviceGstRatePercent = priced.gstRatePercent;
      minimumChargeAdjustment = priced.minimumChargeAdjustment;
      minimumChargeRuleId = priced.minimumChargeRuleId;
    }

    // Phase 8 — resolves each product line's real GST (was previously ignored entirely
    // here — see gstAmount below) and closes a gap discovered alongside it: this path never
    // called resolveProductFee() at all, so remontCommission/vendorPayout were hardcoded to
    // 0/gross for every product bought this way. Same resolvers master-orders.module.ts's
    // checkout() already uses.
    let productsTaxableAmount = 0, productGstOnTop = 0;
    let productCommissionTotal = 0, productMarketingTotal = 0, productGatewayTotal = 0;
    let productCommissionRuleId: string | null = null, productCommissionRuleLabel = 'No rule — ₹0';
    let productMarketingRuleId: string | null = null, productMarketingRuleLabel = 'No rule — ₹0';
    let productGatewayRuleId: string | null = null, productGatewayRuleLabel = 'No rule — ₹0';
    // Phase 3 (C-02/C-03) — which single ProductVendor (if any, and if there's exactly one)
    // this order's product lines belong to. This legacy single-Order path (predates the
    // Child-Order-split engine — see MasterOrdersService.checkout()) can mix products from
    // several sellers in one Order with no per-seller split, unlike that engine; a
    // SELLER-funded discount can only be safely attributed when there's exactly one seller
    // to attribute it to, so a mixed-vendor cart here is deliberately left platform-funded
    // (today's unchanged behaviour) rather than guessing which seller bears it.
    const productVendorIds = new Set<string>();
    if (dto.items?.length) {
      const prodTax = await buildTaxRateResolver(this.prisma, 'PRODUCT');
      for (const item of dto.items) {
        const p = await this.prisma.product.findUnique({ where: { id: item.productId } });
        if (!p) throw new NotFoundException(`Product not found: ${item.productId}`);
        const total = Number(p.price) * item.quantity;
        productsAmount += total;
        if (p.vendorId) productVendorIds.add(p.vendorId);

        const gstLine = await resolveProductGstLine(prodTax, p, total);
        productsTaxableAmount += gstLine.taxableValue;
        if (!gstLine.inclusive) productGstOnTop += gstLine.gstAmount;

        // C-01 fix — fee base is the resolved ex-GST taxable value, not the gross line total.
        // No-op for a GST-Exclusive (or 0%/exempt) line, where these are numerically identical.
        const [commission, marketing, gateway] = await Promise.all([
          resolveProductFee(this.prisma, { feeType: 'COMMISSION', productId: p.id, productCategoryId: p.categoryId, amount: gstLine.taxableValue }),
          resolveProductFee(this.prisma, { feeType: 'MARKETING', productId: p.id, productCategoryId: p.categoryId, amount: gstLine.taxableValue }),
          resolveProductFee(this.prisma, { feeType: 'GATEWAY', productId: p.id, productCategoryId: p.categoryId, amount: gstLine.taxableValue }),
        ]);
        productCommissionTotal += commission.feeAmount; productCommissionRuleId = commission.ruleId; productCommissionRuleLabel = commission.ruleLabel;
        productMarketingTotal += marketing.feeAmount; productMarketingRuleId = marketing.ruleId; productMarketingRuleLabel = marketing.ruleLabel;
        productGatewayTotal += gateway.feeAmount; productGatewayRuleId = gateway.ruleId; productGatewayRuleLabel = gateway.ruleLabel;

        // Fix — vendorId was never copied onto the OrderItem here (unlike
        // MasterOrdersService.checkout(), which already sets `vendorId: g.vendorId` from
        // the exact same Product.vendorId field). ProductLedgerService.settleProductOrder()
        // resolves which seller to settle via `order.items.find(it => it.vendorId)` — with
        // vendorId always null, a PRODUCT order placed through this endpoint could reach
        // PAID status and settlement would silently no-op, crediting no seller at all.
        itemInputs.push({
          productId: item.productId, quantity: item.quantity, unitPrice: p.price, totalPrice: total,
          gstInclusive: gstLine.inclusive, gstRatePercent: gstLine.ratePercent, taxableValue: gstLine.taxableValue, gstAmount: gstLine.gstAmount,
          vendorId: p.vendorId,
        });
      }
    }


    let subtotal = serviceAmount + productsAmount;
    const membershipPct = await this.memberships.getActiveDiscount(customerId);
    const membershipDiscount = Math.round((subtotal * membershipPct) / 100 * 100) / 100;

    let couponDiscount = 0;
    let couponId: string | undefined;
    let couponFundedBy: 'PLATFORM' | 'SELLER' = 'PLATFORM';
    if (dto.couponCode) {
      const v = await this.coupons.validate(dto.couponCode, customerId, subtotal - membershipDiscount);
      if (!v.valid) throw new BadRequestException(v.reason);
      couponDiscount = v.discountAmount || 0;
      couponId = v.coupon?.id;
      couponFundedBy = (v.coupon as any)?.fundedBy === 'SELLER' ? 'SELLER' : 'PLATFORM';
    }

    const discountedSubtotal = subtotal - membershipDiscount - couponDiscount;
    // Phase 8 — SERVICE-side GST stays flat 18%, applied to the service's own discounted
    // share only (this Order can hold one service AND products together — predates the
    // Child-Order-split engine). PRODUCT-side GST is the real per-item figure resolved
    // above; an INCLUSIVE line's tax is embedded in its price and never added again here.
    const serviceDiscountShare = subtotal > 0
      ? Math.round(((serviceAmount / subtotal) * (membershipDiscount + couponDiscount)) * 100) / 100
      : 0;
    const discountedServiceAmount = Math.max(0, serviceAmount - serviceDiscountShare);
    // Service model from the category (a booking mixing products keeps the legacy pricing).
    const svcGst = await serviceBookingGst(this.prisma, dto.items?.length ? null : serviceCategory, {
      serviceAmount, commission: commissionResult.commissionAmount, discount: serviceDiscountShare, serviceRatePercent: serviceGstRatePercent,
    });
    const serviceGstAmount = svcGst.gstAmount;

    // Phase 3 (C-02/C-03) — a SELLER-funded coupon reduces the PRODUCT taxable base/GST by
    // its share of the combined discount, exactly like the SERVICE share above already
    // does — but ONLY when every product line belongs to the same single seller (see the
    // productVendorIds comment above); a mixed-vendor cart stays platform-funded/unchanged,
    // since there's no single seller to attribute the reduction to. See
    // applySellerFundedDiscountToProductGst() in common/index.ts for why scaling both
    // taxableValue and gstAmount by the same ratio is exact, not an approximation.
    const singleProductVendorId = productVendorIds.size === 1 ? [...productVendorIds][0] : null;
    let productTaxableAdjustment = 0;
    const productSellerFunded = couponFundedBy === 'SELLER' && productsAmount > 0 && !!singleProductVendorId;
    if (productSellerFunded) {
      const productDiscountShare = subtotal > 0
        ? Math.round(((productsAmount / subtotal) * (membershipDiscount + couponDiscount)) * 100) / 100
        : 0;
      const before = productsTaxableAmount;
      const scaled = applySellerFundedDiscountToProductGst(itemInputs, before, productGstOnTop, productsAmount, productDiscountShare);
      itemInputs.length = 0;
      itemInputs.push(...scaled.items);
      productsTaxableAmount = scaled.productsTaxableAmount;
      productGstOnTop = scaled.productGstOnTop;
      productTaxableAdjustment = Math.round((before - scaled.productsTaxableAmount) * 100) / 100;
    }
    const gstAmount = Math.round((serviceGstAmount + productGstOnTop) * 100) / 100;
    const walletUsed = Math.min(dto.walletAmount || 0, discountedSubtotal + gstAmount);
    const totalAmount = Math.max(0, discountedSubtotal + gstAmount - walletUsed);
    // remontCommission/vendorPayout now account for BOTH the service leg (unchanged
    // resolveCommission() figure) and the product leg (Phase-7 resolveProductFee(), newly
    // wired in here) — kept additive so the existing service-only display/read paths that
    // expect remontCommission to include the service commission are unaffected when there
    // are no products on the order (productCommissionTotal is 0 in that case).
    const remontCommission = commissionResult.commissionAmount + productCommissionTotal;
    const vendorPayout = (serviceAmount - commissionResult.commissionAmount)
      + (productsTaxableAmount - productCommissionTotal - productMarketingTotal - productGatewayTotal);
    const feeTax = await buildTaxRateResolver(this.prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
    const productFeeGstRate = feeTax.rateFor(null, null);
    const productFeeTotal = productCommissionTotal + productMarketingTotal + productGatewayTotal;
    const productGstOnFeesAmount = Math.round(((productFeeTotal * productFeeGstRate) / 100) * 100) / 100;
    const productFeeBreakdown = dto.items?.length
      ? {
          commission: { amount: productCommissionTotal, ruleId: productCommissionRuleId, ruleLabel: productCommissionRuleLabel },
          marketing: { amount: productMarketingTotal, ruleId: productMarketingRuleId, ruleLabel: productMarketingRuleLabel },
          gateway: { amount: productGatewayTotal, ruleId: productGatewayRuleId, ruleLabel: productGatewayRuleLabel },
          gstOnFees: { amount: productGstOnFeesAmount, ratePercent: productFeeGstRate },
        }
      : undefined;


    return { serviceAmount, productsAmount, commissionResult, minimumChargeAdjustment, minimumChargeRuleId, itemInputs, productsTaxableAmount, subtotal, membershipDiscount, couponDiscount, couponId, couponFundedBy, singleProductVendorId, productTaxableAdjustment, gstAmount, walletUsed, totalAmount, remontCommission, vendorPayout, productFeeBreakdown, serviceModel: svcGst.serviceModel, platformFeeGst: svcGst.platformFeeGst, partnerServiceGst: svcGst.partnerServiceGst };
  }

  /** What POST /orders would charge for this cart, without creating anything. */
  async quote(customerId: string, dto: CreateOrderDto) {
    const p = await this.priceOrder(customerId, dto);
    return {
      currency: 'INR',
      serviceAmount: p.serviceAmount,
      minimumChargeAdjustment: p.minimumChargeAdjustment,
      productsAmount: p.productsAmount,
      subtotal: p.subtotal,
      membershipDiscount: p.membershipDiscount,
      couponDiscount: p.couponDiscount,
      gstAmount: p.gstAmount,
      walletUsed: p.walletUsed,
      totalAmount: p.totalAmount,
      // MARKETPLACE: Remont's platform fee (inside serviceAmount) and the GST split; a registered
      // partner's GST on their share is added once they accept the job.
      serviceModel: p.serviceModel, platformFee: p.serviceModel === 'MARKETPLACE' ? p.commissionResult.commissionAmount : 0,
      platformFeeGst: p.platformFeeGst, partnerServiceGst: p.partnerServiceGst,
    };
  }

  async create(customerId: string, dto: CreateOrderDto) {
    // Idempotency (M-06) — opt-in: see MasterOrdersService.checkout()'s matching comment.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.order.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { items: true, service: true, address: true },
      });
      if (existing) return existing;
    }

    // City activation gate: if the order names a city that resolves to a managed City row
    // and that row is deactivated, block the order. Unresolvable/unmanaged city text is
    // allowed through unchanged — this only tightens the case we can actually verify.
    if (dto.city) {
      const city = await this.cities.getByName(dto.city);
      if (city && !city.isActive) {
        throw new BadRequestException(`${city.name} is not currently accepting orders`);
      }
    }

    const { serviceAmount, productsAmount, commissionResult, minimumChargeAdjustment, minimumChargeRuleId, itemInputs, productsTaxableAmount, subtotal, membershipDiscount, couponDiscount, couponId, couponFundedBy, singleProductVendorId, productTaxableAdjustment, gstAmount, walletUsed, totalAmount, remontCommission, vendorPayout, productFeeBreakdown, serviceModel, platformFeeGst, partnerServiceGst } = await this.priceOrder(customerId, dto);

    // Resolve addressId: if an inline address is provided and no addressId, create one
    let resolvedAddressId = dto.addressId;
    let resolvedAddress: Awaited<ReturnType<typeof this.prisma.address.findUnique>> = null;
    if (!resolvedAddressId && dto.inlineAddress) {
      // Previously hardcoded latitude/longitude to 0 regardless of what the client had —
      // the DTO didn't even declare the fields, so Nest's global whitelist silently stripped
      // any coords a client sent. Every order created this way landed at "Null Island",
      // which DispatchService.dispatch() then treats as a real GPS fix thousands of km from
      // every vendor, excluding all of them and leaving the order permanently undispatched.
      const lat = dto.inlineAddress.latitude;
      const lng = dto.inlineAddress.longitude;
      const hasValidCoords = isValidIndiaCoords(lat, lng);
      resolvedAddress = await this.prisma.address.create({
        data: {
          userId: customerId,
          label: dto.inlineAddress.label || 'Delivery Address',
          fullAddress: dto.inlineAddress.fullAddress,
          city: dto.inlineAddress.city || '',
          state: dto.inlineAddress.state || '',
          pincode: dto.inlineAddress.pincode || '',
          latitude: hasValidCoords ? lat! : 0,
          longitude: hasValidCoords ? lng! : 0,
        },
      });
      resolvedAddressId = resolvedAddress.id;
    } else if (resolvedAddressId) {
      // An existing saved address was selected — snapshot it as it is *right now*.
      // Later edits to this Address row must not retroactively change this order.
      resolvedAddress = await this.prisma.address.findUnique({ where: { id: resolvedAddressId } });
    }
    const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

    let order;
    try {
      // Phase 8 (H-07) — atomic stock check/decrement for every product line, in the SAME
      // transaction as order creation (this path predates the Child-Order-split engine and
      // was never itself wrapped in a transaction before — see MasterOrdersService.
      // checkout()'s matching call for the shared helper/idiom). Insufficient stock rolls
      // back the whole create() — no partially-created order, no oversold item.
      order = await this.prisma.$transaction(async (tx) => {
        if (dto.items?.length) await reserveProductStock(tx, dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
        // Wallet portion debited atomically with the order row: one conditional decrement (never
        // below zero, even under concurrent checkouts); insufficient balance rolls everything back.
        if (walletUsed > 0) {
          const debited = await tx.user.updateMany({ where: { id: customerId, walletBalance: { gte: walletUsed } }, data: { walletBalance: { decrement: walletUsed } } });
          if (debited.count !== 1) throw new BadRequestException('Insufficient wallet balance');
        }
        const created = await tx.order.create({
          data: {
            orderNumber, customerId,
            type: dto.type, channel: dto.channel || BookingChannel.WEBSITE,
            serviceId: dto.serviceId, addressId: resolvedAddressId,
            ...addressSnapshotFields(resolvedAddress),
            slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
            slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
            startOtp, endOtp, status: OrderStatus.PENDING_PAYMENT,
            serviceAmount, productsAmount, subtotal,
            productsTaxableAmount: dto.items?.length ? productsTaxableAmount : undefined,
            productFeeBreakdown: productFeeBreakdown as any,
            couponCode: dto.couponCode, couponDiscount, membershipDiscount,
            walletUsed, gstAmount, totalAmount, remontCommission, vendorPayout,
            ...(serviceModel ? { serviceModel, platformFeeGst, partnerServiceGst } : {}),
            commissionRuleId: commissionResult.ruleId, commissionRuleLabel: commissionResult.ruleLabel,
            minimumChargeAdjustment, minimumChargeRuleId: minimumChargeRuleId || undefined,
            aiSessionId: dto.aiSessionId, leadId: dto.leadId,
            guestName: dto.guestName,
            guestPhone: dto.guestPhone,
            idempotencyKey: dto.idempotencyKey || undefined,
            items: itemInputs.length ? { create: itemInputs } : undefined,
          },
          include: { items: true, service: true, address: true },
        });
        if (walletUsed > 0) {
          const after = await tx.user.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
          await tx.walletTransaction.create({
            data: {
              userId: customerId, type: 'DEBIT', reason: 'ORDER_PAYMENT', amount: walletUsed, balanceAfter: after!.walletBalance,
              orderId: created.id, notes: `Payment for order ${created.orderNumber}`,
            },
          });
        }
        return created;
      });
    } catch (e: any) {
      // Idempotency race: two concurrent requests with the same key can both pass the
      // up-front check above before either commits — the @unique constraint is what actually
      // arbitrates that race; the loser lands here and returns the winner's order.
      if (dto.idempotencyKey && e?.code === 'P2002' && Array.isArray(e?.meta?.target) && e.meta.target.includes('idempotencyKey')) {
        const existing = await this.prisma.order.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: { items: true, service: true, address: true },
        });
        if (existing) return existing;
      }
      throw e;
    }

    // Phase 3 (C-02/C-03/M-04) — see MasterOrdersService.checkout()'s matching call for
    // why this is always written, even with zero discount. isProductOrder covers both a
    // pure product order and a mixed BUNDLE order (dto.items?.length > 0 either way);
    // hasReducedServiceComponent flags the mixed case's service half separately, since a
    // single row can't otherwise say "reduced for the service line, not for the products".
    await this.prisma.orderDiscountAllocation.create({
      data: buildDiscountAllocationData({
        orderId: order.id,
        couponId,
        sellerId: singleProductVendorId,
        discountAmount: couponDiscount + membershipDiscount,
        fundingSource: couponFundedBy,
        isProductOrder: !!dto.items?.length,
        taxableValueAdjustment: productTaxableAdjustment,
        hasReducedServiceComponent: serviceAmount > 0,
      }),
    });

    await writeOtpLog(this.prisma, { orderId: order.id, otpType: 'START', otp: startOtp, action: 'GENERATED', requestedByRole: 'SYSTEM' });
    await writeOtpLog(this.prisma, { orderId: order.id, otpType: 'END', otp: endOtp, action: 'GENERATED', requestedByRole: 'SYSTEM' });

    if (couponId) await this.coupons.recordUsage(couponId, customerId, order.id, couponDiscount);

    // (wallet portion was debited inside the creation transaction above)
    return order;
  }

  async confirmPayment(orderId: string, paymentId: string, gatewayOrderId?: string, signature?: string, callerUserId?: string) {
    const existing = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) throw new NotFoundException('Order not found');

    // PAYMENT SECURITY — authorization: only applies when called from the JWT-authenticated
    // controller (callerUserId passed in). The public/guest confirm-payment route has no
    // login to check against and is unaffected — same "guest-safe" design as retryPayment().
    if (callerUserId && existing.customerId !== callerUserId) {
      throw new ForbiddenException();
    }

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

    let verifiedGatewayOrderId: string;
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
      verifiedGatewayOrderId = gatewayOrderId;
    } else {
      // Fallback: require a pre-verified PaymentTransaction (set by webhook or /payments/verify)
      // for this EXACT paymentId, linked to this order — not just any PAID row on the order.
      const tx = await this.prisma.paymentTransaction.findFirst({
        where: { orderId, status: 'PAID', gatewayPaymentId: paymentId },
      });
      if (!tx || !tx.gatewayOrderId) throw new BadRequestException('Payment not verified. Contact support.');
      verifiedGatewayOrderId = tx.gatewayOrderId;
    }

    // PAYMENT SECURITY — a valid signature only proves *a* payment happened; it never proves
    // it covers this order's real price. Re-derive what Razorpay actually captured for this
    // exact payment (never the client-supplied amount, never our own locally-stored
    // PaymentTransaction.amount) and compare against the order's server-side total before
    // trusting it as "paid". Overpayment is allowed through unchanged; underpayment is not.
    const capturedAmount = await this.payments.getVerifiedCapturedAmount(verifiedGatewayOrderId, paymentId);
    if (capturedAmount + 0.01 < Number(existing.totalAmount)) {
      throw new BadRequestException('Payment amount does not cover the order total. Please contact support.');
    }

    // The gateway row for this verified payment is PAID (the browser callback used to leave it
    // PENDING unless the webhook arrived — so the job still looked unpaid).
    await this.prisma.paymentTransaction.updateMany({
      where: { orderId, gatewayOrderId: verifiedGatewayOrderId, status: { not: 'PAID' } },
      data: { status: 'PAID', gatewayPaymentId: paymentId },
    });
    const wasPendingPayment = existing.status === OrderStatus.PENDING_PAYMENT;
    // Exactly one confirmation wins (browser callback, webhook, retries racing): a conditional
    // update — the loser returns the already-confirmed order and never re-dispatches.
    const won = await this.prisma.order.updateMany({
      where: { id: orderId, paymentStatus: { not: 'PAID' }, status: existing.status },
      data: {
        paymentId, paymentStatus: 'PAID', paymentMethod: 'ONLINE',
        status: wasPendingPayment ? OrderStatus.CONFIRMED : existing.status,
      },
    });
    if (won.count !== 1) return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
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
   * The single authoritative "what has been paid for this job" — used by the partner apps, the
   * customer, collections and earnings. Counts only VERIFIED money: this job's own PAID payments,
   * its share of a verified cart (master-order) payment (cartPaidAmount) and the wallet already
   * taken at checkout is excluded from totalAmount by construction. Partner-reported cash that is
   * not yet confirmed is shown separately and is never counted as received.
   */
  async paymentPosition(orderId: string, client: any = this.prisma) {
    const order = await client.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const rows: { amount: any; status: string; gateway: string }[] = await client.paymentTransaction.findMany({
      where: { orderId, isWalletTopup: false, refundRequestId: null, status: { in: ['PAID', 'PENDING'] } },
      select: { amount: true, status: true, gateway: true },
    });
    const verifiedOwn = r2m(rows.filter((r) => r.status === 'PAID').reduce((a, r) => a + Number(r.amount), 0));
    const pendingCash = r2m(rows.filter((r) => r.status === 'PENDING' && r.gateway === 'CASH_COLLECTION').reduce((a, r) => a + Number(r.amount), 0));
    let cartPaid = Number(order.cartPaidAmount || 0);
    // Cart jobs paid online before cartPaidAmount existed: the verified cart payment (on the master
    // order) covered the job's checkout total, i.e. today's total minus extra work approved later.
    if (order.cartPaidAmount == null && order.masterOrderId && order.paymentStatus === 'PAID') {
      const masterPaid = await client.paymentTransaction.findFirst({ where: { orderId: order.masterOrderId, status: 'PAID', isWalletTopup: false, refundRequestId: null }, select: { id: true } });
      if (masterPaid) {
        const extras = await client.extraWorkItem.findMany({ where: { orderId, customerApproved: true }, select: { amount: true } });
        cartPaid = Math.max(0, r2m(Number(order.totalAmount) - extras.reduce((a: number, e: any) => a + Number(e.amount), 0)));
      }
    }
    const wallet = Number(order.walletUsed || 0);
    const payable = Number(order.totalAmount); // already net of the wallet portion
    const paidAmount = r2m(verifiedOwn + cartPaid);
    const outstanding = Math.max(0, r2m(payable - paidAmount)); // not yet VERIFIED as received
    return {
      order, payable, walletUsed: wallet, paidAmount, cartPaidAmount: cartPaid,
      pendingVerificationAmount: pendingCash,
      outstanding,
      // what may still be collected: outstanding minus cash already reported (awaiting confirmation)
      balanceDue: Math.max(0, r2m(outstanding - pendingCash)),
    };
  }

  /**
   * Partner/admin records cash/UPI/card taken in person. The amount is always the server's own
   * balance due (never a client figure), computed under a row lock so two taps can't record it
   * twice. Partner-reported cash is PENDING until confirmed (completion OTP, the customer, or an
   * admin); an admin's own record is verified. Nothing is collectible on a fully paid job.
   */
  private async recordCashCollectionTx(
    tx: any,
    p: { actorUserId: string; orderId: string; mode: PaymentCollectionMode; collectedLocation?: string; verification: CashVerification | null },
  ) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${p.orderId} FOR UPDATE`;
    const pos = await this.paymentPosition(p.orderId, tx);
    if (['CANCELLED', 'REFUNDED'].includes(pos.order.status)) throw new BadRequestException('Cannot collect payment for a cancelled/refunded order');
    if (pos.balanceDue <= 0) return null;
    const verified = !!p.verification;
    const payment = await tx.paymentTransaction.create({
      data: {
        orderId: p.orderId, userId: pos.order.customerId, amount: pos.balanceDue, status: verified ? 'PAID' : 'PENDING',
        gateway: 'CASH_COLLECTION', collectionMode: p.mode, collectedBy: p.actorUserId, collectedLocation: p.collectedLocation,
        ...(verified ? { verifiedAt: new Date(), verifiedBy: p.actorUserId, verificationMethod: p.verification } : {}),
      },
    });
    if (verified) await this.applyVerifiedCashTx(tx, pos.order, Number(payment.amount), p.actorUserId, p.mode);
    else if (!pos.order.paymentMethod) await tx.order.update({ where: { id: p.orderId }, data: { paymentMethod: 'COD' } });
    return payment;
  }

  /** Effects of cash once verified: the collecting partner holds it (ledger debit), order status. */
  private async applyVerifiedCashTx(tx: any, order: any, amount: number, actorUserId: string, mode: string) {
    if (order.vendorId) {
      await this.ledger.postEntry(tx, order.vendorId, 'COD_COLLECTION', -amount, {
        orderId: order.id, notes: `Cash/UPI/card collected from customer (${mode})`, createdBy: actorUserId,
      });
      await tx.serviceVendor.update({ where: { id: order.vendorId }, data: { pendingPayout: { decrement: amount } } });
    }
    const after = await this.paymentPosition(order.id, tx);
    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: after.outstanding <= 0 ? 'PAID' : 'PARTIAL', paymentMethod: order.paymentMethod || 'COD' },
    });
  }

  /** Confirms partner-reported cash still PENDING on this order (used at OTP-verified completion). */
  private async confirmPendingCashTx(tx: any, orderId: string, method: CashVerification, actorUserId: string, onlyCollectedBy?: string) {
    const rows = await tx.paymentTransaction.findMany({
      where: { orderId, status: 'PENDING', gateway: 'CASH_COLLECTION', ...(onlyCollectedBy ? { collectedBy: onlyCollectedBy } : {}) },
    });
    for (const r of rows) {
      const claim = await tx.paymentTransaction.updateMany({
        where: { id: r.id, status: 'PENDING' },
        data: { status: 'PAID', verifiedAt: new Date(), verifiedBy: actorUserId, verificationMethod: method },
      });
      if (claim.count !== 1) continue;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      await this.applyVerifiedCashTx(tx, order, Number(r.amount), r.collectedBy || actorUserId, r.collectionMode || 'CASH');
    }
    return rows.length;
  }

  async collectCod(
    actorUserId: string, actorRole: UserRole, orderId: string,
    mode: PaymentCollectionMode, collectedLocation?: string,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.paymentMethod === 'ONLINE') throw new BadRequestException('This order was paid online, not COD');
    if (order.paymentStatus === 'PAID') return order; // idempotent
    return this.collectInPerson(actorUserId, actorRole, orderId, mode, collectedLocation);
  }

  async getBalance(orderId: string, actorUserId?: string, actorRole?: UserRole) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundException('Order not found');
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    const isAdmin = !!actorRole && adminRoles.includes(actorRole);
    if (actorUserId && !isAdmin && order.customerId !== actorUserId && order.vendor?.userId !== actorUserId) {
      throw new ForbiddenException();
    }
    const pos = await this.paymentPosition(orderId);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      // Order value including the wallet portion, so totalAmount − (paidAmount + walletUsed)
      // − pendingVerificationAmount = balanceDue reads correctly on every screen.
      totalAmount: r2m(pos.payable + pos.walletUsed),
      payableAfterWallet: pos.payable,
      walletUsed: pos.walletUsed,
      paidAmount: pos.paidAmount,
      cartPaidAmount: pos.cartPaidAmount,
      pendingVerificationAmount: pos.pendingVerificationAmount,
      balanceDue: pos.balanceDue,
      paymentStatus: order.paymentStatus,
    };
  }

  /**
   * Collect any outstanding balance. CASH/UPI/CARD in person → recorded (partner-reported cash
   * stays PENDING until confirmed; see recordCashCollectionTx); ONLINE → a payment link/order
   * for the exact balance due, confirmed server-side. A fully paid job has nothing to collect.
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
      const balance = await this.getBalance(orderId);
      if (balance.balanceDue <= 0) return { ...balance, message: 'Nothing due — already fully paid' };
      const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
      const payOrder: any = await this.payments.initiatePayment(order.customerId, balance.balanceDue, order.id, frontendUrl);
      return {
        orderId: order.id, orderNumber: order.orderNumber, balanceDue: balance.balanceDue,
        requiresPayment: true, gateway: payOrder.gateway, gatewayOrderId: payOrder.gatewayOrderId,
        razorpayKeyId: payOrder.keyId, txId: payOrder.txId,
      };
    }
    return this.collectInPerson(actorUserId, actorRole, orderId, mode, collectedLocation);
  }

  private async collectInPerson(actorUserId: string, actorRole: UserRole, orderId: string, mode: PaymentCollectionMode, collectedLocation?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { vendor: true } });
    if (!order) throw new NotFoundException('Order not found');
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    const isAdmin = adminRoles.includes(actorRole);
    if (!isAdmin && order.vendor?.userId !== actorUserId) throw new ForbiddenException();
    const payment = await this.prisma.$transaction((tx) => this.recordCashCollectionTx(tx, {
      actorUserId, orderId, mode, collectedLocation, verification: isAdmin ? 'ADMIN' : null,
    }));
    if (!payment) return { ...(await this.getBalance(orderId)), message: 'Nothing due — already fully paid or awaiting confirmation' };
    await writeOrderTimeline(this.prisma, {
      orderId, status: payment.status === 'PAID' ? 'BALANCE_COLLECTED' : 'CASH_REPORTED', actorId: actorUserId, actorRole,
      note: `₹${Number(payment.amount)} via ${mode}${payment.status === 'PAID' ? '' : ' — reported by partner, awaiting customer/admin confirmation'}${collectedLocation ? ` at ${collectedLocation}` : ''}`,
    });
    const updated = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (payment.status === 'PAID') {
      if (updated.paymentStatus === 'PAID') this.notifyPaymentSuccess(updated).catch(() => {});
      await this.releaseJobEarnings(orderId).catch((e) => this.logger.warn(`Earnings release ${orderId}: ${e.message}`));
    }
    return { ...updated, cashCollection: { id: payment.id, amount: Number(payment.amount), status: payment.status } };
  }

  /**
   * The customer (or an admin) confirms cash a partner reported collecting. Only the order's own
   * customer or an admin; only PENDING cash rows; once.
   */
  async verifyCashCollection(actor: { sub: string; role: UserRole }, orderId: string, paymentId: string, evidence?: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const isAdmin = actor.role === UserRole.ADMIN || actor.role === UserRole.SUPER_ADMIN;
    if (!isAdmin && order.customerId !== actor.sub) throw new ForbiddenException();
    // The customer's own confirmation is the evidence; an admin must record what they checked
    // (call with the customer, receipt, deposit reference…) — kept in the audit log.
    const note = String(evidence || '').trim();
    if (isAdmin && note.length < 10) throw new BadRequestException('Record how the cash was confirmed (at least 10 characters)');
    const done = await this.prisma.$transaction(async (tx) => {
      const row = await tx.paymentTransaction.findFirst({ where: { id: paymentId, orderId, gateway: 'CASH_COLLECTION' } });
      if (!row) throw new NotFoundException('Cash collection not found');
      const claim = await tx.paymentTransaction.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'PAID', verifiedAt: new Date(), verifiedBy: actor.sub, verificationMethod: isAdmin ? 'ADMIN' : 'CUSTOMER' },
      });
      if (claim.count !== 1) return false;
      await this.applyVerifiedCashTx(tx, order, Number(row.amount), row.collectedBy || actor.sub, row.collectionMode || 'CASH');
      return true;
    });
    if (done) {
      await writeOrderTimeline(this.prisma, { orderId, status: 'CASH_CONFIRMED', actorId: actor.sub, actorRole: actor.role, note: isAdmin ? `Confirmed by admin: ${note}` : 'Confirmed by customer' });
      await logAudit(this.prisma, {
        actorId: actor.sub, actorRole: actor.role, action: 'CASH_COLLECTION_CONFIRMED', targetType: 'PaymentTransaction', targetId: paymentId,
        metadata: { orderId, orderNumber: order.orderNumber, method: isAdmin ? 'ADMIN' : 'CUSTOMER', evidence: isAdmin ? note : null },
      });
      await this.releaseJobEarnings(orderId).catch((e) => this.logger.warn(`Earnings release ${orderId}: ${e.message}`));
    }
    return this.getBalance(orderId);
  }

  /**
   * Confirms an ONLINE balance/extra-work payment. Deliberately separate from confirmPayment():
   * a balance payment can happen after completion and must never move status. Verified with the
   * gateway signature AND the amount Razorpay actually captured.
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
    const captured = await this.payments.getVerifiedCapturedAmount(gatewayOrderId, paymentId);
    if (captured + 0.01 < Number(linkedTx.amount)) throw new BadRequestException('Payment amount does not cover the balance. Please contact support.');
    await this.prisma.paymentTransaction.updateMany({
      where: { id: linkedTx.id, status: { not: 'PAID' } },
      data: { status: 'PAID', gatewayPaymentId: paymentId, gatewaySignature: signature },
    });
    return this.settleAfterOnlinePayment(orderId);
  }

  /** After any verified online money on an order: payment status, then earnings if now fully paid. */
  private async settleAfterOnlinePayment(orderId: string) {
    const pos = await this.paymentPosition(orderId);
    const newPaymentStatus = pos.outstanding <= 0 ? 'PAID' : pos.paidAmount > 0 ? 'PARTIAL' : pos.order.paymentStatus;
    const updated = await this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: newPaymentStatus } });
    if (newPaymentStatus === 'PAID' && pos.order.paymentStatus !== 'PAID') this.notifyPaymentSuccess(updated).catch(() => {});
    await this.releaseJobEarnings(orderId).catch((e) => this.logger.warn(`Earnings release ${orderId}: ${e.message}`));
    return updated;
  }

  /**
   * Server-side follow-up for a payment Razorpay captured (webhook): a first payment confirms and
   * dispatches the order exactly like the browser callback would (idempotent); a later balance
   * payment updates the payment status and releases earnings. Master (cart) orders are handled
   * by MasterOrdersService; top-ups/AMC elsewhere.
   */
  @OnEvent('payment.order.captured', { async: true })
  async onOrderPaymentCaptured(p: { orderId?: string | null; gatewayPaymentId: string }) {
    if (!p?.orderId) return;
    const order = await this.prisma.order.findUnique({ where: { id: p.orderId } });
    if (!order) return;
    try {
      const firstPaymentStatuses: string[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED, OrderStatus.VENDOR_ASSIGNED, OrderStatus.VENDOR_EN_ROUTE];
      if (order.paymentStatus !== 'PAID' && firstPaymentStatuses.includes(order.status) && Number(order.totalAmount) > 0) {
        await this.confirmPayment(order.id, p.gatewayPaymentId);
      } else {
        await this.settleAfterOnlinePayment(order.id);
      }
    } catch (e: any) {
      this.logger.warn(`Webhook follow-up for order ${order.orderNumber}: ${e.message}`);
    }
  }

  /**
   * Partner earnings for a completed job are posted ONCE, and only when the customer's payment is
   * fully verified (online, verified cash, cart share, wallet). Until then the job is DEFERRED and
   * nothing is withdrawable. Same amounts as before (JOB_EARNING gross, commission true-up net of
   * lead cost, warranty hold). Legacy jobs (earningsStatus null) are never touched.
   */
  async releaseJobEarnings(orderId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { vendor: true, service: { include: { category: true } } } });
      if (!order || order.earningsStatus !== 'DEFERRED' || !order.vendor || order.vendor.staffType === 'IN_HOUSE') return false;
      if (!['COMPLETED', 'INVOICED', 'CLOSED'].includes(order.status)) return false;
      const pos = await this.paymentPosition(orderId, tx);
      if (pos.outstanding > 0.009) return false;
      const claim = await tx.order.updateMany({ where: { id: orderId, earningsStatus: 'DEFERRED' }, data: { earningsStatus: 'POSTED', earningsPostedAt: new Date() } });
      if (claim.count !== 1) return false;
      if ((await tx.partnerLedgerEntry.count({ where: { orderId, type: 'JOB_EARNING' } })) > 0) return true; // never twice
      const fullCommission = Number(order.remontCommission);
      const leadCostPaid = Number(order.leadCostAmount);
      const remainingCommission = Math.max(0, fullCommission - leadCostPaid);
      const grossAmount = Number(order.vendorPayout) + fullCommission;
      const completionCredit = grossAmount - remainingCommission; // == vendorPayout + leadCostPaid
      const { days, percent } = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
      const holdAmount = percent > 0 ? Math.round(completionCredit * percent) / 100 : 0;
      if (order.serviceModel === 'MARKETPLACE') {
        // Partner marketplace: the customer paid Remont's platform fee (+ its GST) directly, so the
        // partner is credited their share, never charged commission. A registered partner also gets
        // the GST on their share that the customer paid (theirs to remit); under 9(5) Remont is the
        // liable person and keeps it. Lead cost (an advance against commission) is returned.
        const payout = Number(order.vendorPayout);
        const registered = !!order.vendor.gstin && isValidGstinFormat(String(order.vendor.gstin));
        const partnerGst = registered ? Number(order.partnerServiceGst) : 0;
        let leadReturned = 0;
        if (leadCostPaid > 0) {
          const claimLead = await tx.order.updateMany({ where: { id: orderId, leadCostRefunded: false }, data: { leadCostRefunded: true } });
          if (claimLead.count === 1) leadReturned = leadCostPaid;
        }
        await tx.serviceVendor.update({
          where: { id: order.vendor.id },
          data: { totalEarnings: { increment: payout }, pendingPayout: { increment: payout + leadReturned + partnerGst - holdAmount } },
        });
        await this.ledger.postEntry(tx, order.vendor.id, 'JOB_EARNING', payout, { orderId, notes: 'Partner share of the service (platform fee paid by the customer)' });
        if (leadReturned > 0) await this.ledger.postEntry(tx, order.vendor.id, 'LEAD_COST', leadReturned, { orderId, notes: 'Lead cost returned — the platform fee was paid by the customer' });
        if (partnerGst > 0) await this.ledger.postEntry(tx, order.vendor.id, 'GST', partnerGst, { orderId, notes: "Your GST on this service, collected from the customer — yours to remit" });
        if (holdAmount > 0) {
          const releaseDueAt = new Date();
          releaseDueAt.setDate(releaseDueAt.getDate() + days);
          await this.ledger.postHold(tx, order.vendor.id, 'WARRANTY_HOLD', holdAmount, { orderId, releaseDueAt });
        }
        return true;
      }
      // GST on Remont's commission is invoiced to the partner (commission invoice). Whether the
      // partner ledger also recovers it is a CA/accounting decision — configurable, OFF by default
      // (the approved behaviour: the ledger recovers the commission only).
      const gstRecovery = (await tx.siteSetting.findUnique({ where: { key: 'partner_commission_gst_recovery' } }))?.value === 'true';
      let commissionGst = 0;
      if (gstRecovery && fullCommission > 0) {
        const feeTax = await buildTaxRateResolver(tx, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
        commissionGst = r2m((fullCommission * feeTax.rateFor(null, null)) / 100);
      }
      const releasedNow = completionCredit - holdAmount - commissionGst;
      await tx.serviceVendor.update({
        where: { id: order.vendor.id },
        data: { totalEarnings: { increment: Number(order.vendorPayout) }, pendingPayout: { increment: releasedNow } },
      });
      await this.ledger.postEntry(tx, order.vendor.id, 'JOB_EARNING', grossAmount, { orderId });
      await this.ledger.trueUpCommission(tx, order.vendor.id, orderId, remainingCommission);
      if (commissionGst > 0) {
        await this.ledger.postEntry(tx, order.vendor.id, 'GST', -commissionGst, { orderId, notes: 'GST on Remont commission (as invoiced to the partner)' });
      }
      if (holdAmount > 0) {
        const releaseDueAt = new Date();
        releaseDueAt.setDate(releaseDueAt.getDate() + days);
        await this.ledger.postHold(tx, order.vendor.id, 'WARRANTY_HOLD', holdAmount, { orderId, releaseDueAt });
      }
      return true;
    });
  }

  /** Safety net: completed jobs whose earnings are still DEFERRED but are now fully paid. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepDeferredEarnings() {
    const due = await this.prisma.order.findMany({
      where: { earningsStatus: 'DEFERRED', status: { in: ['COMPLETED', 'INVOICED', 'CLOSED'] } },
      select: { id: true }, take: 200, orderBy: { completedAt: 'asc' },
    });
    for (const o of due) await this.releaseJobEarnings(o.id).catch(() => undefined);
  }

  /**
   * One code check with a hard attempt limit that also holds under concurrency: an attempt slot
   * is taken atomically BEFORE comparing, so a burst of parallel guesses can never exceed the
   * limit. A wrong code keeps the slot; the right one resets the counter. A missing code is never
   * skipped (a new code must be sent), and a re-sent code expires.
   */
  private async assertOrderOtp(order: any, type: 'START' | 'END', otp: string) {
    const isStart = type === 'START';
    const code: string | null = isStart ? order.startOtp : order.endOtp;
    const label = isStart ? 'start' : 'completion';
    if (!code) throw new BadRequestException(`No ${label} OTP is active for this job — request a new OTP for the customer`);
    const expires: Date | null = isStart ? order.startOtpExpiresAt : order.endOtpExpiresAt;
    if (expires && new Date(expires).getTime() < Date.now()) throw new BadRequestException(`This ${label} OTP has expired — request a new one`);
    const counter = isStart ? 'startOtpFailedAttempts' : 'endOtpFailedAttempts';
    const slot = await this.prisma.order.updateMany({
      where: { id: order.id, [counter]: { lt: OTP_MAX_FAILED_ATTEMPTS } },
      data: { [counter]: { increment: 1 } },
    });
    if (slot.count !== 1) throw new BadRequestException(`Too many wrong ${label} OTP attempts — request a new OTP for the customer`);
    if (String(otp ?? '') !== code) {
      const after = await this.prisma.order.findUnique({ where: { id: order.id }, select: { [counter]: true } as any });
      const left = OTP_MAX_FAILED_ATTEMPTS - Number((after as any)?.[counter] ?? OTP_MAX_FAILED_ATTEMPTS);
      throw new BadRequestException(left > 0 ? `Invalid OTP (${left} attempt${left === 1 ? '' : 's'} left)` : `Invalid OTP — too many attempts; request a new OTP for the customer`);
    }
    await this.prisma.order.update({ where: { id: order.id }, data: { [counter]: 0 } });
  }

  async markEnRoute(vendorUserId: string, orderId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    // Guarded on the FROM status — previously this had no status check at all, so calling
    // this endpoint on an already-STARTED/COMPLETED/CANCELLED order would silently revert
    // its status back to VENDOR_EN_ROUTE, corrupting the timeline and re-opening a closed
    // job. Allowing VENDOR_EN_ROUTE itself in the guard keeps a retried/duplicate call a
    // safe no-op instead of an error.
    const result = await this.prisma.order.updateMany({
      where: { id: orderId, vendorId: v.id, status: { in: [OrderStatus.VENDOR_ASSIGNED, OrderStatus.VENDOR_EN_ROUTE] } },
      data: { status: OrderStatus.VENDOR_EN_ROUTE },
    });
    if (result.count === 0) throw new BadRequestException('Order cannot be marked en-route at this stage');
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.VENDOR_EN_ROUTE, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    return result;
  }

  /**
   * Partner "I have arrived": records a fresh location and the server's verification decision
   * (recordPartnerArrival in common). The order status is NOT changed — arrival is evidence,
   * kept separate from the partner's self-reported progress. Idempotent.
   */
  async markArrived(vendorUserId: string, orderId: string, body: { latitude?: number; longitude?: number; accuracyM?: number; locationError?: string }) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (!order.arrivedAt && !['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE'].includes(order.status)) {
      throw new BadRequestException('Arrival can only be recorded before the job starts');
    }
    return recordPartnerArrival(this.prisma, order, body || {}, { vendorId: v.id });
  }

  async verifyStartOtp(vendorUserId: string, orderId: string, otp: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (order.status !== OrderStatus.VENDOR_EN_ROUTE) throw new BadRequestException('Order is not en-route');
    await this.assertOrderOtp(order, 'START', otp);
    const moved = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.VENDOR_EN_ROUTE },
      data: { startOtpVerified: true, startedAt: new Date(), status: OrderStatus.STARTED },
    });
    if (moved.count !== 1) throw new BadRequestException('Order is not en-route');
    const updated = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.STARTED, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    await writeOtpLog(this.prisma, { orderId, otpType: 'START', otp, action: 'VERIFIED', requestedByRole: 'VENDOR', requestedById: v.id });
    return updated;
  }

  async complete(
    vendorUserId: string, orderId: string, otp: string, photosAfter: string[], videoUrl?: string,
    collection?: { mode?: PaymentCollectionMode; collectedLocation?: string },
  ) {
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
    if (collection?.mode && !['CASH', 'UPI', 'CARD'].includes(collection.mode)) throw new BadRequestException('Invalid collection mode');
    // The customer's completion OTP is required (a missing code is never skipped — a new one must
    // be sent). It confirms the job AND any cash the partner takes for it on this visit.
    await this.assertOrderOtp(order, 'END', otp);

    // Completion proof photos arrive as data: URIs (partner portal + app contract). They go
    // through the central media pipeline only now that the request is known to be valid, and
    // only their Cloudinary URLs are stored on the order — never the base64 itself.
    const vendorActor = { id: vendorUserId, role: UserRole.SERVICE_VENDOR };
    const photos = await this.storeCompletionPhotos(photosAfter, vendorActor);

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
        data: { status: OrderStatus.COMPLETED, completedAt: new Date(), photosAfter: photos.urls, videoUrl, endOtpVerified: true, earningsStatus: v.staffType === 'IN_HOUSE' ? 'NOT_APPLICABLE' : 'DEFERRED' },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Order cannot be completed at this stage');
      }
      // Job count moves now; partner EARNINGS are posted only once the customer's payment is
      // verified (releaseJobEarnings, below and on every later payment event) — a completed but
      // unpaid job is never withdrawable. In-house staff never earn partner money.
      await tx.serviceVendor.update({ where: { id: v.id }, data: { completedJobs: { increment: 1 } } });
      // The customer's completion OTP confirms cash this partner reported on this visit, and any
      // collection submitted together with the completion.
      await this.confirmPendingCashTx(tx, orderId, 'COMPLETION_OTP', vendorUserId, vendorUserId);
      if (collection?.mode) {
        await this.recordCashCollectionTx(tx, { actorUserId: vendorUserId, orderId, mode: collection.mode, collectedLocation: collection.collectedLocation, verification: 'COMPLETION_OTP' });
      }
      const updated = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      return updated;
    }).catch(async (e) => {
      // Completion lost (e.g. a concurrent double-submit won) — don't leave its photos behind.
      await Promise.all(photos.ingested.map((m) => this.media?.remove(m.id, vendorActor).catch(() => undefined)));
      throw e;
    });
    if (photos.ingested.length) {
      await this.media?.linkByUrls({ entityType: MediaEntityType.PROJECT, entityId: orderId, urls: photos.urls, actor: vendorActor });
    }
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.COMPLETED, actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    await writeOtpLog(this.prisma, { orderId, otpType: 'END', otp, action: 'VERIFIED', requestedByRole: 'VENDOR', requestedById: v.id });
    await this.releaseJobEarnings(orderId).catch((e) => this.logger.warn(`Earnings release ${orderId}: ${e.message}`));
    this.autoGenerateInvoice(orderId).catch((e) => this.logger.warn(`Auto-invoice failed: ${e.message}`));
    this.notifyWorkCompleted(completed).catch(() => {});
    return completed;
  }

  /**
   * Converts inline (data: URI) completion photos into Cloudinary media through the central
   * pipeline; entries that are already URLs pass through unchanged. All-or-nothing: if any
   * photo is rejected, the ones already stored are removed and the completion fails with the
   * pipeline's error (e.g. a virus-scan rejection), so the partner can retry.
   */
  private async storeCompletionPhotos(photos: unknown, actor: { id: string; role: UserRole }): Promise<{ urls: string[]; ingested: PublicMedia[] }> {
    if (photos === undefined || photos === null) return { urls: [], ingested: [] };
    if (!Array.isArray(photos) || photos.some((p) => typeof p !== 'string')) throw new BadRequestException('photosAfter must be a list of images');
    if (photos.length > MAX_COMPLETION_PHOTOS) throw new BadRequestException(`At most ${MAX_COMPLETION_PHOTOS} completion photos are allowed`);
    if (!photos.some(isInlineImage)) return { urls: photos as string[], ingested: [] };
    if (!this.media) throw new InternalServerErrorException('Media storage is not available');

    const urls: string[] = [];
    const ingested: PublicMedia[] = [];
    try {
      for (const [i, p] of (photos as string[]).entries()) {
        if (!isInlineImage(p)) { urls.push(p); continue; }
        const m = await this.media.ingestDataUrl(p, { originalName: `job-photo-${i + 1}`, entityType: MediaEntityType.PROJECT, actor });
        ingested.push(m);
        urls.push(m.variants?.full ?? m.deliveryUrl!);
      }
    } catch (e) {
      await Promise.all(ingested.map((m) => this.media!.remove(m.id, actor).catch(() => undefined)));
      throw e;
    }
    return { urls, ingested };
  }

  private async notifyWorkCompleted(order:{ id: string; customerId: string; guestPhone: string | null; orderNumber: string }) {
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
      data: isStart
        ? { startOtp: newOtp, startOtpLastSentAt: now, startOtpFailedAttempts: 0, startOtpExpiresAt: new Date(now.getTime() + OTP_RESENT_VALIDITY_MS) }
        : { endOtp: newOtp, endOtpLastSentAt: now, endOtpFailedAttempts: 0, endOtpExpiresAt: new Date(now.getTime() + OTP_RESENT_VALIDITY_MS) },
    });
    await writeOtpLog(this.prisma, { orderId, otpType: type, otp: newOtp, action: 'REGENERATED', requestedByRole: 'VENDOR', requestedById: v.id });

    const phone = order.guestPhone || (await this.prisma.user.findUnique({ where: { id: order.customerId }, select: { phone: true } }))?.phone;
    if (phone) {
      this.paymentNotify.otpResent(order.customerId, phone, order.orderNumber, type, newOtp, order.id).catch(() => {});
    }

    return { orderId, otpType: type, sentAt: now };
  }

  // Fire-and-forget from complete() — a throw here must never crash job completion. Previously
  // a failure was only logged, leaving the order stuck COMPLETED with no invoice and no admin
  // visibility forever. Now the failure (and its clearing on a later successful retry) is
  // recorded on the order itself — see invoiceGenerationFailed/invoiceGenerationError in
  // schema.prisma. generateForOrder() is already idempotent (returns the existing Invoice if
  // one exists), so this can be safely re-run by AdminService.generateInvoice() any number of
  // times without ever creating a duplicate.
  private async autoGenerateInvoice(orderId: string) {
    try {
      await this.invoices.generateForOrder(orderId);
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.INVOICED, invoiceGenerationFailed: false, invoiceGenerationError: null },
      });
    } catch (e) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { invoiceGenerationFailed: true, invoiceGenerationError: String(e.message || e).slice(0, 1000) },
      }).catch(() => {}); // never let the failure-tracking write itself throw past this method
      throw e;
    }
  }

  async myOrders(customerId: string, status?: OrderStatus) {
    return this.prisma.order.findMany({
      where: { customerId, ...(status ? { status } : {}) },
      include: {
        service: true, items: { include: { product: true } },
        serviceItems: { include: { service: true } },
        vendor: { select: { id: true, photoUrl: true, rating: true, user: { select: { name: true, phone: true } } } },
        address: true, extraWorkItems: true, delivery: true,
        // Phase 3 — demo/mock shipment tracking (backend/src/modules/logistics). Shows the
        // last-persisted status immediately; the frontend separately calls
        // GET /logistics/shipments/:id to refresh it live (that's where status actually
        // gets recomputed/updated — this include is read-only, adds no new query cost logic).
        shipment: true,
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
        vendor: { select: { id: true, userId: true, photoUrl: true, rating: true, user: { select: { name: true, phone: true } } } },
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

  // Phase 6 — a PRODUCT order's cancellation behaviour now depends on the physical shipment
  // stage: before pickup, a plain cancel (unchanged, falls through below); after pickup
  // (PICKED_UP/IN_TRANSIT/OUT_FOR_DELIVERY), the item is physically in the logistics network —
  // simply flipping status to CANCELLED would silently orphan it, so this triggers an RTO
  // (return-to-origin) instead via ReturnsService.initiateRto(); once DELIVERED (or
  // Order.status already COMPLETED), cancellation is no longer possible — the customer must
  // raise a normal return request instead. SERVICE-order behaviour below is byte-for-byte
  // unchanged.
  async cancel(userId: string, orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { shipment: true, items: { take: 1 } } });
    if (!order || order.customerId !== userId) throw new ForbiddenException();

    const isProduct = order.type === 'PRODUCT' || (order.items?.length ?? 0) > 0;
    if (isProduct) {
      if (['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(order.status)) {
        throw new BadRequestException('This order can no longer be cancelled — please raise a return request instead');
      }
      if (order.shipment && ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(order.shipment.status)) {
        await this.returns.initiateRto({ id: order.id, orderNumber: order.orderNumber }, order.shipment.id, userId, reason);
        return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      }
      if (order.shipment?.status === 'DELIVERED') {
        throw new BadRequestException('This order has already been delivered — please raise a return request instead');
      }
      // else: not yet shipped — falls through to the plain-cancel transaction below, unchanged
    } else if (['COMPLETED', 'INVOICED', 'CLOSED', 'CANCELLED', 'REFUNDED', 'IN_PROGRESS'].includes(order.status)) {
      throw new BadRequestException('Cannot cancel at this stage');
    } else if (order.startOtpVerified || ['STARTED', 'EXTRA_WORK_ADDED'].includes(order.status)) {
      // The customer shared the START OTP: the work has begun, so self-service cancellation is
      // closed. Genuine problems still go to Support/Admin as a complaint.
      throw new ConflictException({
        error: 'SERVICE_STARTED',
        message: 'The service has already started (you shared the start OTP), so it can no longer be cancelled here. If something is wrong, please raise a complaint — our team will review it.',
      });
    } else if (order.arrivedAt) {
      // The partner has already arrived: cancellation goes to admin review (with the arrival
      // evidence and the configured penalty) instead of an instant cancel — never decided here.
      throw new ConflictException({
        error: 'CANCELLATION_REVIEW_REQUIRED',
        message: 'Your partner has already arrived, so this cancellation needs a quick review by our team. Please submit a cancellation request.',
      });
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
      // Money already received (online payment and/or wallet) is never lost track of: the
      // cancellation records a refund REQUEST for admin review — it moves no money. Skipped
      // when one is already open for this order.
      // Wallet taken at checkout for an order that was never paid goes straight back (once).
      const walletReturned = await releaseUnpaidOrderWallet(tx, order, `Order ${order.orderNumber} cancelled before payment`);
      const received = order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL' || Number(order.cartPaidAmount || 0) > 0
        || (!walletReturned && Number(order.walletUsed || 0) > 0);
      if (received) {
        const open = await tx.refundRequest.findFirst({ where: { orderId, status: { in: ['REQUESTED', 'PARTNER_RESPONDED', 'UNDER_REVIEW', 'ESCALATED'] } }, select: { id: true } });
        if (!open) {
          const rr = await tx.refundRequest.create({
            data: { orderId, customerId: order.customerId, reason: `Order cancelled by the customer: ${reason || 'no reason given'}`, evidenceUrls: [], partnerId: order.vendorId || undefined, status: 'REQUESTED' },
          });
          await tx.refundRequestLog.create({ data: { refundRequestId: rr.id, actorId: userId, actorRole: UserRole.CUSTOMER, action: 'REQUESTED', notes: 'Raised automatically on cancellation — awaiting admin review' } });
        }
      }
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
    // Phase 8 (M-06) — the one remaining order-creation path with no idempotency guard at
    // all; same opt-in pattern as MasterOrdersService.checkout()/OrdersService.create().
    if (dto.idempotencyKey) {
      const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        return {
          orderNumber: existing.orderNumber, orderId: existing.id, status: existing.status,
          paymentMethod: existing.paymentMethod, totalAmount: existing.totalAmount,
          message: 'Booking already recorded for this request.',
        };
      }
    }

    // Find or create customer by phone
    let user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone: dto.phone,
          name: dto.name,
          email: dto.email || undefined,
          role: UserRole.CUSTOMER,
          // Not verified by a typed phone number — only by the customer's own OTP login.
          isVerified: false,
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
    const priced = await priceServiceBooking(this.prisma, svc, city.id, cityPrice !== null ? cityPrice : Number(svc.basePrice));
    const serviceAmount = priced.serviceAmount;
    const commissionResult = priced.commissionResult;

    const svcGst = await serviceBookingGst(this.prisma, (svc as any).category, { serviceAmount, commission: commissionResult.commissionAmount, serviceRatePercent: priced.gstRatePercent });
    const gstAmount = svcGst.gstAmount;
    const totalAmount = Math.round((serviceAmount + gstAmount) * 100) / 100;

    // Parse slot datetime as IST (UTC+5:30) to avoid local-timezone drift
    const paddedTime = dto.slotTime.length === 5 ? dto.slotTime : `${dto.slotTime}:00`;
    const slotStart = new Date(`${dto.slotDate}T${paddedTime}:00+05:30`);
    const slotEnd = new Date(slotStart.getTime() + svc.durationMinutes * 60 * 1000);

    const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Create address inline (full address as free text). Prefers the customer's actual
    // GPS fix (already captured client-side for the saved-address GPS-proximity sanity
    // check, just not previously threaded through here) over the city centroid — a
    // city-wide fallback is far less precise for nearest-partner dispatch than a real
    // location, and this is the highest-traffic guest booking path on the site.
    const hasRealCoords = isValidIndiaCoords(dto.latitude, dto.longitude);
    const address = await this.prisma.address.create({
      data: {
        userId: user.id,
        label: 'Booking Address',
        fullAddress: dto.fullAddress,
        city: city.name,
        state: city.state,
        pincode: dto.pincode || '000000',
        latitude: hasRealCoords ? dto.latitude! : city.latitude,
        longitude: hasRealCoords ? dto.longitude! : city.longitude,
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
    let order;
    try {
      order = await this.prisma.order.create({
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
          ...(svcGst.serviceModel ? { serviceModel: svcGst.serviceModel, platformFeeGst: svcGst.platformFeeGst, partnerServiceGst: svcGst.partnerServiceGst } : {}),
          minimumChargeAdjustment: priced.minimumChargeAdjustment, minimumChargeRuleId: priced.minimumChargeRuleId || undefined,
          vendorPayout: serviceAmount - commissionResult.commissionAmount,
          commissionRuleId: commissionResult.ruleId,
          commissionRuleLabel: commissionResult.ruleLabel,
          idempotencyKey: dto.idempotencyKey || undefined,
        },
        include: {
          service: { select: { name: true, durationMinutes: true } },
          address: true,
          customer: { select: { name: true, phone: true } },
        },
      });
    } catch (e: any) {
      if (dto.idempotencyKey && e?.code === 'P2002' && Array.isArray(e?.meta?.target) && e.meta.target.includes('idempotencyKey')) {
        const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (existing) {
          return {
            orderNumber: existing.orderNumber, orderId: existing.id, status: existing.status,
            paymentMethod: existing.paymentMethod, totalAmount: existing.totalAmount,
            message: 'Booking already recorded for this request.',
          };
        }
      }
      throw e;
    }

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
    // Idempotency (M-06) — opt-in: see MasterOrdersService.checkout()'s matching comment.
    // A guest retrying the same checkout (double-tap, network retry) with the same key gets
    // back the order already created for it instead of a second one; COD orders are already
    // CONFIRMED at creation (nothing more to do), an ONLINE order still PENDING_PAYMENT gets
    // a fresh gateway order bound to this SAME existing Order.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) return this.resumeProductCheckoutResponse(existing);
    }

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

    // Phase 8 — resolves each line's real GST (was previously a flat 18% on the whole
    // cart, ignoring TaxConfig/HSN/gstOverridePercent/gstInclusive entirely) and closes a
    // gap discovered alongside it: this guest "buy now" path never called
    // resolveProductFee() at all, so remontCommission/vendorPayout were hardcoded to 0
    // below — every guest product purchase bypassed seller settlement. Same resolvers
    // master-orders.module.ts's checkout() already uses.
    let productsAmount = 0, productsTaxableAmount = 0, productGstOnTop = 0;
    let commissionTotal = 0, marketingTotal = 0, gatewayTotal = 0;
    let commissionRuleId: string | null = null, commissionRuleLabel = 'No rule — ₹0';
    let marketingRuleId: string | null = null, marketingRuleLabel = 'No rule — ₹0';
    let gatewayRuleId: string | null = null, gatewayRuleLabel = 'No rule — ₹0';
    const itemInputs: any[] = [];
    const prodTax = await buildTaxRateResolver(this.prisma, 'PRODUCT');
    for (const item of dto.items) {
      const p = await this.prisma.product.findUnique({ where: { id: item.productId } });
      if (!p) throw new NotFoundException(`Product not found: ${item.productId}`);
      const lineTotal = Number(p.price) * item.quantity;
      productsAmount += lineTotal;

      const gstLine = await resolveProductGstLine(prodTax, p, lineTotal);
      productsTaxableAmount += gstLine.taxableValue;
      if (!gstLine.inclusive) productGstOnTop += gstLine.gstAmount;

      // C-01 fix — fee base is the resolved ex-GST taxable value, not the gross line total.
      // No-op for a GST-Exclusive (or 0%/exempt) line, where these are numerically identical.
      const [commission, marketing, gateway] = await Promise.all([
        resolveProductFee(this.prisma, { feeType: 'COMMISSION', productId: p.id, productCategoryId: p.categoryId, amount: gstLine.taxableValue }),
        resolveProductFee(this.prisma, { feeType: 'MARKETING', productId: p.id, productCategoryId: p.categoryId, amount: gstLine.taxableValue }),
        resolveProductFee(this.prisma, { feeType: 'GATEWAY', productId: p.id, productCategoryId: p.categoryId, amount: gstLine.taxableValue }),
      ]);
      commissionTotal += commission.feeAmount; commissionRuleId = commission.ruleId; commissionRuleLabel = commission.ruleLabel;
      marketingTotal += marketing.feeAmount; marketingRuleId = marketing.ruleId; marketingRuleLabel = marketing.ruleLabel;
      gatewayTotal += gateway.feeAmount; gatewayRuleId = gateway.ruleId; gatewayRuleLabel = gateway.ruleLabel;

      itemInputs.push({
        productId: item.productId, quantity: item.quantity, unitPrice: p.price, totalPrice: lineTotal,
        gstInclusive: gstLine.inclusive, gstRatePercent: gstLine.ratePercent, taxableValue: gstLine.taxableValue, gstAmount: gstLine.gstAmount,
      });
    }

    const gstAmount = productGstOnTop;
    const totalAmount = productsAmount + gstAmount;
    const feeTax = await buildTaxRateResolver(this.prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
    const feeGstRate = feeTax.rateFor(null, null);
    const feeTotal = commissionTotal + marketingTotal + gatewayTotal;
    const gstOnFeesAmount = Math.round(((feeTotal * feeGstRate) / 100) * 100) / 100;
    const productFeeBreakdown = {
      commission: { amount: commissionTotal, ruleId: commissionRuleId, ruleLabel: commissionRuleLabel },
      marketing: { amount: marketingTotal, ruleId: marketingRuleId, ruleLabel: marketingRuleLabel },
      gateway: { amount: gatewayTotal, ruleId: gatewayRuleId, ruleLabel: gatewayRuleLabel },
      gstOnFees: { amount: gstOnFeesAmount, ratePercent: feeGstRate },
    };
    const vendorPayout = productsTaxableAmount - commissionTotal - marketingTotal - gatewayTotal;

    const lat = dto.latitude || 0;
    const lng = dto.longitude || 0;
    const validCoords = isValidIndiaCoords(lat, lng);
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

    let order;
    try {
      // Phase 8 (H-07) — same atomic stock check/decrement as the other two checkout
      // paths, in the same transaction as order creation.
      order = await this.prisma.$transaction(async (tx) => {
        await reserveProductStock(tx, dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
        return tx.order.create({
          data: {
            orderNumber, customerId: user.id, type: OrderType.PRODUCT,
            channel: BookingChannel.WEBSITE, addressId: address.id,
            ...addressSnapshotFields(address),
            guestName: dto.name, guestPhone: dto.phone, guestEmail: dto.email || null,
            productsAmount, productsTaxableAmount, subtotal: productsAmount, gstAmount, totalAmount,
            startOtp: Math.floor(1000 + Math.random() * 9000).toString(),
            remontCommission: commissionTotal, vendorPayout,
            productFeeBreakdown: productFeeBreakdown as any,
            status: isCOD ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT,
            paymentStatus: 'PENDING',
            adminNotes: isCOD ? 'COD order' : null,
            idempotencyKey: dto.idempotencyKey || undefined,
            items: { create: itemInputs },
          },
        });
      });
    } catch (e: any) {
      if (dto.idempotencyKey && e?.code === 'P2002' && Array.isArray(e?.meta?.target) && e.meta.target.includes('idempotencyKey')) {
        const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (existing) return this.resumeProductCheckoutResponse(existing);
      }
      throw e;
    }

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

  // Idempotency (M-06) — mirrors MasterOrdersService.resumeCheckoutResponse() for the
  // single-Order guest product path: never creates a second Order for the same key.
  private async resumeProductCheckoutResponse(order: { id: string; orderNumber: string; totalAmount: any; status: OrderStatus; customerId: string | null }) {
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      return { orderNumber: order.orderNumber, orderId: order.id, totalAmount: Number(order.totalAmount), paymentMethod: 'COD', isCOD: true, alreadyProcessed: true };
    }
    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    const payOrder: any = await this.payments.initiatePayment(order.customerId!, Number(order.totalAmount), order.id, frontendUrl);
    if (payOrder.gateway === 'PHONEPE') {
      return {
        orderNumber: order.orderNumber, orderId: order.id, totalAmount: Number(order.totalAmount),
        paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
        gateway: 'PHONEPE', redirectUrl: payOrder.redirectUrl, txId: payOrder.txId,
      };
    }
    return {
      orderNumber: order.orderNumber, orderId: order.id, totalAmount: Number(order.totalAmount),
      paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
      gateway: 'RAZORPAY', gatewayOrderId: payOrder.gatewayOrderId, razorpayKeyId: payOrder.keyId, txId: payOrder.txId,
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
        vendor: { select: { id: true, fullName: true, photoUrl: true, rating: true, user: { select: { name: true, phone: true } } } },
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
  // Same pricing as POST /orders (priceOrder), nothing created.
  @Post('quote') quote(@CurrentUser() u: JwtPayload, @Body() dto: CreateOrderDto) { return this.orders.quote(u.sub, dto); }
  @Post(':id/confirm-payment') pay(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { paymentId: string; gatewayOrderId?: string; signature?: string }) { return this.orders.confirmPayment(id, b.paymentId, b.gatewayOrderId, b.signature, u.sub); }
  @Get('mine') mine(@CurrentUser() u: JwtPayload, @Query('status') s?: OrderStatus) { return this.orders.myOrders(u.sub, s); }
  @Get(':id') one(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.orders.getOne(u.sub, id); }
  @Patch(':id/cancel') cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { reason: string }) {
    return this.orders.cancel(u.sub, id, b.reason);
  }
  @Patch(':id/en-route') enRoute(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.orders.markEnRoute(u.sub, id); }
  // Partner "I have arrived" — fresh location evidence; order status unchanged.
  @Patch(':id/arrived') arrived(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: PartnerArrivalDto) { return this.orders.markArrived(u.sub, id, b); }
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
  @Post(':id/extra-work/otp') extraOtp(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.extras.requestOtp(u.sub, id);
  }
  @Post(':id/extra-work/verify-otp') extraVerify(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { otp: string }) {
    return this.extras.verifyOtp(u.sub, id, b.otp);
  }
  // collection (optional): { mode: CASH|UPI|CARD } — cash taken on this visit, confirmed by the
  // same customer completion OTP. Older clients that omit it are unaffected.
  @Post(':id/complete') complete(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { otp: string; photosAfter: string[]; videoUrl?: string; collection?: { mode?: PaymentCollectionMode; collectedLocation?: string } }) {
    return this.orders.complete(u.sub, id, b.otp, b.photosAfter, b.videoUrl, b.collection);
  }
  // The customer (or an admin) confirms cash a partner reported collecting.
  @Post(':id/cash-collections/:paymentId/confirm') confirmCash(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('paymentId') paymentId: string, @Body() b: { evidence?: string }) {
    return this.orders.verifyCashCollection({ sub: u.sub, role: u.role }, id, paymentId, b?.evidence);
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
  imports: [CouponsModule, MembershipsModule, WhatsappModule, CitiesModule, PaymentsModule, PaymentNotificationsModule, PartnerLedgerModule, InvoicesModule, ReturnsModule, MediaModule],
  controllers: [OrdersController, PublicBookingController],
  providers: [OrdersService, DispatchService, RoutingService, ExtraWorkService, GuestBookingService, DispatchRetryService],
  exports: [OrdersService, DispatchService, RoutingService],
})
export class OrdersModule {}
