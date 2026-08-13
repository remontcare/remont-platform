import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgencyStatus, Language, OrderStatus, UserRole, VendorStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, haversineKm, normalizeSkillKey, writeOrderTimeline, VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } from '../../common';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';
import { PartnerRegistrationService, PartnerRegistrationModule } from '../partner-registration/partner-registration.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';

export class ServiceVendorRegistrationDto {
  @IsString() fullName: string;
  @IsString() baseCity: string;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) skills: string[];
  @IsOptional() @IsString() businessName?: string;
  @IsOptional() @IsBoolean() isAgencyOwner?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) serviceRadius?: number;
  @IsOptional() @IsEnum(Language) preferredLanguage?: Language;
}

export class VendorLocationDto {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng: number;
}

export class VendorOnlineStatusDto {
  @IsBoolean() isOnline: boolean;
}

export class VendorAttendanceDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng?: number;
}

// ─── Service Vendor ───
@Injectable()
export class ServiceVendorsService {
  constructor(
    private prisma: PrismaService,
    private wa: WhatsappService,
    private events: EventEmitter2,
    private ledger: PartnerLedgerService,
  ) {}

  async register(userId: string, data: ServiceVendorRegistrationDto) {
    // Agency ownership is only a registration declaration. Approval and routing-priority
    // fields are never copied from a vendor-controlled request.
    const skills = Array.from(new Set(data.skills.map(normalizeSkillKey).filter(Boolean)));
    if (!skills.length) throw new BadRequestException('At least one valid skill is required');
    const safeData = {
      fullName: data.fullName.trim(),
      baseCity: data.baseCity.trim(),
      skills,
      ...(data.businessName !== undefined ? { businessName: data.businessName.trim() } : {}),
      ...(data.isAgencyOwner !== undefined ? { isAgencyOwner: data.isAgencyOwner } : {}),
      ...(data.serviceRadius !== undefined ? { serviceRadius: data.serviceRadius } : {}),
      ...(data.preferredLanguage !== undefined ? { preferredLanguage: data.preferredLanguage } : {}),
    };
    // Base Hold starts at the platform default on first registration only — never
    // overwritten on a later profile-edit upsert, so an admin's per-vendor adjustment sticks.
    const baseHoldAmount = await this.ledger.getBaseHoldDefault();
    return this.prisma.serviceVendor.upsert({
      where: { userId },
      create: { userId, baseHoldAmount, ...safeData },
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
    const vendor = await this.requireActiveVendor(userId);
    return this.prisma.serviceVendor.update({
      where: { id: vendor.id },
      data: { currentLatitude: lat, currentLongitude: lng, lastLocationUpdate: new Date(), isOnline: true },
      select: { id: true, isOnline: true },
    });
  }

  async setOnlineStatus(userId: string, isOnline: boolean) {
    const vendor = await this.requireActiveVendor(userId);
    return this.prisma.serviceVendor.update({ where: { id: vendor.id }, data: { isOnline } });
  }

  private async requireActiveVendor(userId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!vendor) throw new NotFoundException('Vendor profile not found');
    if (vendor.status !== VendorStatus.ACTIVE) {
      throw new ForbiddenException('Your vendor account is not active');
    }
    if (vendor.memberStatus === 'FROZEN') {
      throw new ForbiddenException('Your account is frozen — contact your agency or Remont support');
    }
    return vendor;
  }

  // Mirrors the availableJobs() where-clause gate (dispatchAttempts >= 1, fulfillmentType
  // in the VENDOR_DISPATCHABLE_FULFILLMENT_TYPES allowlist) for the single-order accept path.
  private isReleasedForVendorDispatch(order: any): boolean {
    return order.dispatchAttempts >= 1 && VENDOR_DISPATCHABLE_FULFILLMENT_TYPES.includes(order.service?.fulfillmentType);
  }

  private isEligibleForOrder(vendor: any, order: any) {
    const skill = order.service?.category?.key;
    if (!skill || !vendor.skills.includes(skill)) return false;
    const address = order.address;
    if (vendor.currentLatitude != null && vendor.currentLongitude != null) {
      if (address?.latitude == null || address?.longitude == null) return true;
      return haversineKm(vendor.currentLatitude, vendor.currentLongitude, address.latitude, address.longitude) <= vendor.serviceRadius;
    }
    return !address?.city || address.city.toLowerCase() === vendor.baseCity.toLowerCase();
  }

  // Phase 2 — minimal daily attendance. `date` is always normalized to midnight so the
  // (vendorId, date) unique constraint upserts the same row across multiple check-ins/outs
  // in a day, same "one row per day" idiom @db.Date columns are meant for.
  private todayDate() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Plausibility bound, not a real anti-spoofing system (that needs device attestation) —
  // rejects the cheap case of a malformed/off-the-map coordinate (e.g. 0,0 from a stubbed
  // location API) while still allowing a legitimate vendor working anywhere in India.
  private isPlausibleIndianCoordinate(lat?: number, lng?: number): boolean {
    if (lat == null || lng == null) return true;
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;
  }

  async checkIn(userId: string, lat?: number, lng?: number) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    if (!this.isPlausibleIndianCoordinate(lat, lng)) {
      throw new BadRequestException('Location looks invalid — please enable GPS and try again');
    }
    const date = this.todayDate();
    // One check-in per (vendor, date): a second call must not silently overwrite the first
    // check-in's timestamp/location, which is exactly what the previous upsert did.
    const existing = await this.prisma.vendorAttendance.findUnique({ where: { vendorId_date: { vendorId: v.id, date } } });
    if (existing?.checkInAt) {
      throw new BadRequestException('You have already checked in today');
    }
    return this.prisma.vendorAttendance.upsert({
      where: { vendorId_date: { vendorId: v.id, date } },
      create: { vendorId: v.id, date, checkInAt: new Date(), checkInLat: lat, checkInLng: lng },
      update: { checkInAt: new Date(), checkInLat: lat, checkInLng: lng },
    });
  }

  async checkOut(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    const date = this.todayDate();
    const existing = await this.prisma.vendorAttendance.findUnique({ where: { vendorId_date: { vendorId: v.id, date } } });
    if (!existing?.checkInAt) {
      throw new BadRequestException('You must check in before checking out');
    }
    if (existing.checkOutAt) {
      throw new BadRequestException('You have already checked out today');
    }
    return this.prisma.vendorAttendance.update({
      where: { vendorId_date: { vendorId: v.id, date } },
      data: { checkOutAt: new Date() },
    });
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
    if (status && !Object.values(OrderStatus).includes(status as OrderStatus)) {
      throw new BadRequestException('Invalid order status');
    }
    return this.prisma.order.findMany({
      where: { vendorId: v.id, ...(status ? { status: status as OrderStatus } : {}) },
      include: {
        customer: { select: { name: true, phone: true } },
        service: true, address: true, extraWorkItems: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async availableJobs(userId: string) {
    const v = await this.requireActiveVendor(userId);

    // Same category-matching rule as DispatchService's WhatsApp push, so what a vendor
    // sees when they manually check is never a superset of what they'd be notified for.
    // Two extra gates keep this a *released-for-vendor* list, not "every unassigned order":
    //  - dispatchAttempts >= 1: DispatchService only stamps this once it has actually
    //    rung a wave of candidates, so an order isn't pull-visible a moment before it's
    //    push-visible. Doubles as the "stuck/released" gate — same field the admin
    //    stuck-orders queue (AdminService.listOrders `stuck` filter) keys off.
    //  - fulfillmentType in VENDOR_DISPATCHABLE_FULFILLMENT_TYPES (an allowlist, not a
    //    PROJECT/ADMIN_TEAM blocklist — see that constant's comment in common/index.ts):
    //    RoutingService.route() already never calls dispatch() for a non-dispatchable
    //    type, so dispatchAttempts alone would already exclude them; this is
    //    belt-and-suspenders against a future routing/dispatch change leaking one through,
    //    and stays safe-by-default if a new in-house-only fulfillment type is added later.
    const orders = await this.prisma.order.findMany({
      where: {
        vendorId: null,
        // PENDING_PAYMENT orders are not a job offer. Confirmed COD orders remain
        // eligible, because their lifecycle status is CONFIRMED.
        status: OrderStatus.CONFIRMED,
        dispatchAttempts: { gte: 1 },
        service: { category: { key: { in: v.skills } }, fulfillmentType: { in: VENDOR_DISPATCHABLE_FULFILLMENT_TYPES } },
      },
      include: {
        service: { select: { name: true, categoryId: true } },
        // Use coordinates only for eligibility; do not reveal an unassigned customer's
        // full address, pincode or precise location.
        address: { select: { city: true, latitude: true, longitude: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    return orders
      .filter((o) => this.isEligibleForOrder(v, o))
      .slice(0, 20)
      .map(({ address, ...order }) => ({ ...order, address: address ? { city: address.city } : null }));
  }

  async acceptJob(userId: string, orderId: string) {
    const v = await this.requireActiveVendor(userId);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { service: { include: { category: { select: { key: true } } } }, address: true },
    });
    if (!order) throw new NotFoundException();
    if (order.vendorId || order.status !== OrderStatus.CONFIRMED) {
      throw new BadRequestException('This job is no longer available');
    }
    // Server-side mirror of availableJobs()'s visibility gate — enforced here too so a
    // vendor can't claim an unreleased or in-house-planned order just by guessing/reusing
    // an orderId, independent of whatever the client actually listed.
    if (!this.isReleasedForVendorDispatch(order)) {
      throw new ForbiddenException('This job is not available to your vendor account');
    }
    if (!this.isEligibleForOrder(v, order)) {
      throw new ForbiddenException('This job is not available to your vendor account');
    }

    // Resolved before the transaction — reading a SiteSetting doesn't need to be part of
    // the atomic claim, only the debit itself does.
    const leadCostAmount = await this.ledger.getLeadCostAmount();

    // This conditional update is the claim lock: only one concurrent request can change
    // an unassigned confirmed order to VENDOR_ASSIGNED. The Lead Cost debit rides in the
    // same transaction so a vendor is never charged for a claim that didn't actually win.
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, vendorId: null, status: OrderStatus.CONFIRMED },
        data: { vendorId: v.id, status: 'VENDOR_ASSIGNED' },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('This job was just assigned to another vendor');
      }
      if (leadCostAmount > 0) {
        await tx.order.update({ where: { id: orderId }, data: { leadCostAmount } });
        await this.ledger.postLeadCost(tx, v.id, orderId, leadCostAmount);
        await tx.serviceVendor.update({ where: { id: v.id }, data: { pendingPayout: { decrement: leadCostAmount } } });
      }
    });
    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { customer: true, address: true, service: true },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: 'VENDOR_ASSIGNED', actorId: v.id, actorRole: UserRole.SERVICE_VENDOR });
    await this.wa.sendJobAssigned(v.userId, updated);
    // Stops the ring/retry/WhatsApp-fallback sweep for this order on every other
    // candidate who was also offered it — see job-ring-policy.service.ts.
    this.events.emit('job.offer.resolved', { orderId });
    return updated;
  }

  async rejectJob(userId: string, orderId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException();
    if (order.vendorId !== v.id) throw new ForbiddenException();
    if (order.status !== 'VENDOR_ASSIGNED') {
      throw new BadRequestException('Cannot reject job in its current state');
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { vendorId: null, status: 'CONFIRMED' },
    });
  }

  // NOTE: job status transitions (en-route/verify-otp/complete) and extra-work items are
  // handled by OrdersService/ExtraWorkService in orders.module.ts instead of here — those
  // versions include the real side effects (WhatsApp start-OTP, customer approval + order
  // total recalculation, invoice generation, vendor earnings/wallet updates) that a generic
  // status-PATCH here would not. Removed a duplicate updateJobStatus()/addExtraWork() pair
  // that lived here unused by any frontend, to avoid two endpoints doing the same job with
  // different (and here, incomplete) business logic.

  async getJobDetail(userId: string, orderId: string) {
    const v = await this.requireActiveVendor(userId);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { name: true, phone: true } },
        service: true, address: true, extraWorkItems: true,
      },
    });
    if (!order) throw new NotFoundException();
    if (order.vendorId !== v.id) throw new ForbiddenException('This job is not assigned to you');
    return order;
  }
}

@ApiTags('Vendors')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SERVICE_VENDOR)
@Controller('vendors/service')
export class ServiceVendorsController {
  constructor(private vs: ServiceVendorsService) {}
  @Post('register') reg(@CurrentUser() u: JwtPayload, @Body() b: ServiceVendorRegistrationDto) { return this.vs.register(u.sub, b); }
  @Get('me') me(@CurrentUser() u: JwtPayload) { return this.vs.profile(u.sub); }
  @Patch('me/location') loc(@CurrentUser() u: JwtPayload, @Body() b: VendorLocationDto) { return this.vs.updateLocation(u.sub, b.lat, b.lng); }
  @Patch('me/status') status(@CurrentUser() u: JwtPayload, @Body() b: VendorOnlineStatusDto) { return this.vs.setOnlineStatus(u.sub, b.isOnline); }
  @Patch('me/attendance/check-in') checkIn(@CurrentUser() u: JwtPayload, @Body() b: VendorAttendanceDto) { return this.vs.checkIn(u.sub, b?.lat, b?.lng); }
  @Patch('me/attendance/check-out') checkOut(@CurrentUser() u: JwtPayload) { return this.vs.checkOut(u.sub); }
  @Get('me/earnings') earn(@CurrentUser() u: JwtPayload) { return this.vs.earnings(u.sub); }
  @Get('me/jobs') jobs(@CurrentUser() u: JwtPayload, @Query('status') s?: string) { return this.vs.myJobs(u.sub, s); }
  @Get('me/available-jobs') availJobs(@CurrentUser() u: JwtPayload) { return this.vs.availableJobs(u.sub); }
  @Get('me/jobs/:orderId') jobDetail(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) { return this.vs.getJobDetail(u.sub, id); }
  @Post('me/jobs/:orderId/accept') accept(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) { return this.vs.acceptJob(u.sub, id); }
  @Post('me/jobs/:orderId/reject') reject(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) { return this.vs.rejectJob(u.sub, id); }
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
    // Same today/month/lifetime pattern as ServiceVendorsService.earnings() above — bucketed
    // by createdAt rather than completedAt since product orders don't reliably set
    // completedAt (there's no dedicated product-fulfillment lifecycle yet, unlike services).
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);
    const [total, orders, revenue, todayRevenue, monthRevenue, lowStock] = await Promise.all([
      this.prisma.product.count({ where: { vendorId: v.id } }),
      this.prisma.orderItem.count({ where: { product: { vendorId: v.id } } }),
      this.prisma.orderItem.aggregate({
        where: { product: { vendorId: v.id }, order: { status: 'COMPLETED' } },
        _sum: { totalPrice: true },
      }),
      this.prisma.orderItem.aggregate({
        where: { product: { vendorId: v.id }, order: { status: 'COMPLETED', createdAt: { gte: sod } } },
        _sum: { totalPrice: true },
      }),
      this.prisma.orderItem.aggregate({
        where: { product: { vendorId: v.id }, order: { status: 'COMPLETED', createdAt: { gte: som } } },
        _sum: { totalPrice: true },
      }),
      this.prisma.product.count({ where: { vendorId: v.id, stock: { lte: 5 } } }),
    ]);
    return {
      totalProducts: total, totalOrders: orders,
      totalRevenue: revenue._sum.totalPrice || 0,
      todayRevenue: todayRevenue._sum.totalPrice || 0,
      monthRevenue: monthRevenue._sum.totalPrice || 0,
      lowStockCount: lowStock, rating: v.rating,
    };
  }

  // Orders containing this seller's products — scoped at the query layer (product.vendorId),
  // never exposes another seller's order items. Grouped by parent order since an order can
  // also carry a service booking or another seller's products in the same checkout.
  async myOrders(userId: string) {
    const v = await this.prisma.productVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException();

    const items = await this.prisma.orderItem.findMany({
      where: { product: { vendorId: v.id } },
      include: {
        product: { select: { name: true, images: true } },
        order: {
          select: {
            id: true, orderNumber: true, status: true, paymentStatus: true, createdAt: true,
            customer: { select: { name: true, phone: true } },
            address: { select: { fullAddress: true, city: true, pincode: true } },
            masterOrder: { select: { masterOrderNumber: true } },
          },
        },
      },
      orderBy: { order: { createdAt: 'desc' } },
      take: 200,
    });

    const byOrder = new Map<string, any>();
    for (const item of items) {
      if (!byOrder.has(item.order.id)) {
        byOrder.set(item.order.id, { ...item.order, items: [] });
      }
      byOrder.get(item.order.id).items.push({
        id: item.id,
        productName: item.product.name,
        productImage: item.product.images?.[0] || null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      });
    }
    return Array.from(byOrder.values());
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
  @Get('me/orders') orders(@CurrentUser() u: JwtPayload) { return this.pv.myOrders(u.sub); }
}

// ─── Phase 2: Agency Partner Management (owner-side self-service) ───
// Admin-side agency/member controls (approve/suspend/freeze/transfer) live in
// admin.module.ts next to the equivalent vendor-lifecycle methods; this is only
// what an agency owner does for their own team.
@Injectable()
export class AgencyService {
  constructor(
    private prisma: PrismaService,
    private registrations: PartnerRegistrationService,
    private ledger: PartnerLedgerService,
  ) {}

  private async resolveOwner(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    if (!v.isAgencyOwner) throw new ForbiddenException('Only agency accounts can manage a team');
    return v;
  }

  async inviteMember(userId: string, phone: string, fullName?: string, skills?: string[]) {
    const owner = await this.resolveOwner(userId);
    return this.registrations.inviteAgencyMember(owner.id, phone, fullName, skills);
  }

  async listMembers(userId: string) {
    const owner = await this.resolveOwner(userId);
    return this.prisma.serviceVendor.findMany({
      where: { agencyOwnerId: owner.id },
      select: {
        id: true, fullName: true, skills: true, baseCity: true, rating: true,
        completedJobs: true, memberStatus: true, isOnline: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Stage G — one aggregate endpoint, same "Promise.all of counts/aggregates, spread into
  // one object" idiom as AdminService.globalStats()/fullStats().
  async dashboard(userId: string) {
    const owner = await this.resolveOwner(userId);
    const members = await this.prisma.serviceVendor.findMany({
      where: { agencyOwnerId: owner.id },
      select: { id: true, fullName: true, totalEarnings: true, pendingPayout: true, completedJobs: true, rating: true, memberStatus: true },
    });
    const allIds = [owner.id, ...members.map((m) => m.id)];

    const [totalJobs, completedJobs, pendingJobs, revenueAgg, availableBalance, settlementHistory, withdrawalHistory] = await Promise.all([
      this.prisma.order.count({ where: { vendorId: { in: allIds } } }),
      this.prisma.order.count({ where: { vendorId: { in: allIds }, status: 'COMPLETED' } }),
      this.prisma.order.count({ where: { vendorId: { in: allIds }, status: { in: ['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'] as any[] } } }),
      this.prisma.order.aggregate({ where: { vendorId: { in: allIds }, status: 'COMPLETED' }, _sum: { totalAmount: true } }),
      this.ledger.availableBalance(owner.id),
      this.prisma.partnerSettlement.findMany({ where: { vendorId: { in: allIds } }, orderBy: { paidAt: 'desc' }, take: 100 }),
      this.prisma.withdrawalRequest.findMany({ where: { vendorId: owner.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    return {
      jobs: { total: totalJobs, completed: completedJobs, pending: pendingJobs },
      activeMemberCount: members.filter((m) => m.memberStatus === 'ACTIVE').length,
      totalMemberCount: members.length,
      revenue: revenueAgg._sum.totalAmount || 0,
      availableBalance,
      perMemberEarnings: members.map((m) => ({
        vendorId: m.id, fullName: m.fullName, totalEarnings: m.totalEarnings,
        pendingPayout: m.pendingPayout, completedJobs: m.completedJobs, rating: m.rating, memberStatus: m.memberStatus,
      })),
      settlementHistory,
      withdrawalHistory,
    };
  }

  async attendance(userId: string, dateStr?: string) {
    const owner = await this.resolveOwner(userId);
    const date = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    date.setHours(0, 0, 0, 0);
    const members = await this.prisma.serviceVendor.findMany({ where: { agencyOwnerId: owner.id }, select: { id: true } });
    const vendorIds = [owner.id, ...members.map((m) => m.id)];
    return this.prisma.vendorAttendance.findMany({
      where: { vendorId: { in: vendorIds }, date },
      include: { vendor: { select: { fullName: true } } },
    });
  }
}

@ApiTags('Vendors')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SERVICE_VENDOR)
@Controller('vendors/agency')
export class AgencyController {
  constructor(private agency: AgencyService) {}
  @Post('invite-member') invite(@CurrentUser() u: JwtPayload, @Body() b: { phone: string; fullName?: string; skills?: string[] }) {
    return this.agency.inviteMember(u.sub, b.phone, b.fullName, b.skills);
  }
  @Get('members') members(@CurrentUser() u: JwtPayload) { return this.agency.listMembers(u.sub); }
  @Get('attendance') attendance(@CurrentUser() u: JwtPayload, @Query('date') date?: string) { return this.agency.attendance(u.sub, date); }
  @Get('dashboard') dashboard(@CurrentUser() u: JwtPayload) { return this.agency.dashboard(u.sub); }
}

@Module({
  imports: [WhatsappModule, PartnerRegistrationModule, PartnerLedgerModule],
  controllers: [ServiceVendorsController, ProductVendorsController, AgencyController],
  providers: [ServiceVendorsService, ProductVendorsService, AgencyService],
  exports: [ServiceVendorsService, ProductVendorsService],
})
export class VendorsModule {}
