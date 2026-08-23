import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsPhoneNumber, IsOptional } from 'class-validator';
import { UserRole, VendorStatus, OrderStatus, DeleteTargetType, SettlementMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, slugify, logAudit, writeOrderTimeline, resolveCommission, haversineKm, isValidIndiaCoords, isVendorLocationEligible, boundingBoxForRadius, MAX_DISPATCH_RADIUS_KM, normalizeSkillKey, NOT_FROZEN_MEMBER_FILTER, resolveBillingTransactionType } from '../../common';
import { openAiComplete, parseAiJson } from '../ai-agent/openai-client';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { MasterOrdersService, MasterOrdersModule } from '../master-orders/master-orders.module';
import { SettlementsService, SettlementsModule } from '../settlements/settlements.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';
import { InvoicesService, InvoicesModule } from '../invoices/invoices.module';
import { CrmService, CrmModule } from '../crm/crm.module';

// Validated like auth.module.ts's SendOtpDto/VerifyOtpDto — this endpoint creates a User row
// that must be able to log in via the real OTP flow, so an invalid phone must be rejected up
// front rather than silently creating a seller who can never log in.
export class CreateProductVendorDto {
  @IsString() @IsPhoneNumber('IN') phone: string;
  @IsString() name: string;
  @IsString() businessName: string;
  @IsOptional() @IsString() gstNumber?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() pickupAddress?: string;
}

export class UpdateProductVendorDto {
  @IsOptional() @IsString() businessName?: string;
  @IsOptional() @IsString() gstNumber?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() pickupAddress?: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly openaiKey: string;
  private readonly openaiModel: string;

  constructor(private prisma: PrismaService, private config: ConfigService, private payments: PaymentsService, private settlements: SettlementsService, private cities: CitiesService, private events: EventEmitter2, private ledger: PartnerLedgerService, private invoices: InvoicesService, private crm: CrmService) {
    this.openaiKey = config.get('OPENAI_API_KEY', '');
    this.openaiModel = config.get('OPENAI_MODEL', 'gpt-4o-mini');
  }

  // ─── Dashboard stats ────────────────────────────────────────────────

  async globalStats() {
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(sod); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);
    // MTD-vs-MTD: compare "this month so far" against the SAME number of days into last
    // month, not last month's full total — otherwise a partial month always looks like a
    // decline against a complete one, which isn't a real trend, just a calendar artifact.
    const daysSoFarThisMonth = Math.floor((Date.now() - som.getTime()) / 86400000) + 1;
    const somLastMonth = new Date(som); somLastMonth.setMonth(somLastMonth.getMonth() - 1);
    const sameDayCutoffLastMonth = new Date(somLastMonth); sameDayCutoffLastMonth.setDate(sameDayCutoffLastMonth.getDate() + daysSoFarThisMonth);
    const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);

    const [
      totalUsers, totalCustomers, totalServiceVendors, totalProductVendors,
      activeOnlineVendors, pendingVendorApprovals,
      todayOrders, todayGmv, mtdOrders, mtdGmv,
      activeAmc, totalLeads, conversions, totalCities,
      totalServices, totalProducts,
      yesterdayGmv, lastMonthSameSpanGmv,
      totalOrdersAllTime, customersMonthAgo, vendorsMonthAgo, productsMonthAgo, ordersMonthAgo,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: UserRole.CUSTOMER } }),
      this.prisma.serviceVendor.count(),
      this.prisma.productVendor.count(),
      this.prisma.serviceVendor.count({ where: { isOnline: true, status: VendorStatus.ACTIVE } }),
      this.prisma.serviceVendor.count({ where: { status: VendorStatus.PENDING_VERIFICATION } }),
      this.prisma.order.count({ where: { createdAt: { gte: sod } } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: sod }, paymentStatus: 'PAID' }, _sum: { totalAmount: true } }),
      this.prisma.order.count({ where: { createdAt: { gte: som } } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: som }, paymentStatus: 'PAID' }, _sum: { totalAmount: true } }),
      this.prisma.amcSubscription.count({ where: { status: 'ACTIVE' } }),
      this.prisma.lead.count(),
      this.prisma.lead.count({ where: { status: 'CONVERTED' } }),
      this.prisma.city.count({ where: { isActive: true } }),
      this.prisma.service.count({ where: { isActive: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: yesterdayStart, lt: sod }, paymentStatus: 'PAID' }, _sum: { totalAmount: true } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: somLastMonth, lt: sameDayCutoffLastMonth }, paymentStatus: 'PAID' }, _sum: { totalAmount: true } }),
      this.prisma.order.count(),
      this.prisma.user.count({ where: { role: UserRole.CUSTOMER, createdAt: { lt: monthAgo } } }),
      this.prisma.serviceVendor.count({ where: { createdAt: { lt: monthAgo } } }),
      this.prisma.product.count({ where: { isActive: true, createdAt: { lt: monthAgo } } }),
      this.prisma.order.count({ where: { createdAt: { lt: monthAgo } } }),
    ]);

    // null (not 0) means "no baseline to compare against" — e.g. a brand-new platform with
    // zero orders a month ago has nothing to compute a meaningful % change from.
    const pct = (curr: number, prev: number): number | null => (prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null);

    return {
      users: { total: totalUsers, customers: totalCustomers },
      vendors: { service: totalServiceVendors, product: totalProductVendors, onlineNow: activeOnlineVendors, pendingApprovals: pendingVendorApprovals },
      orders: {
        today: { count: todayOrders, gmv: todayGmv._sum.totalAmount || 0 },
        thisMonth: { count: mtdOrders, gmv: mtdGmv._sum.totalAmount || 0 },
      },
      amc: { active: activeAmc },
      crm: { totalLeads, conversions, conversionRate: totalLeads > 0 ? ((conversions / totalLeads) * 100).toFixed(1) + '%' : '0%' },
      cities: { active: totalCities },
      catalog: { services: totalServices, products: totalProducts },
      // Real period-over-period trend %, used by the dashboard's metric cards — previously
      // those cards showed a hardcoded "↑ X%" regardless of actual data.
      trends: {
        todayRevenuePct: pct(Number(todayGmv._sum.totalAmount || 0), Number(yesterdayGmv._sum.totalAmount || 0)),
        monthRevenuePct: pct(Number(mtdGmv._sum.totalAmount || 0), Number(lastMonthSameSpanGmv._sum.totalAmount || 0)),
        // Total Orders/Customers/Partners/Products cards show cumulative all-time totals, so
        // their "trend" is cumulative growth vs the same total 30 days ago — not new-this-
        // month counts, which would be a different (and here, unlabeled) metric.
        ordersPct: pct(totalOrdersAllTime, ordersMonthAgo),
        customersPct: pct(totalCustomers, customersMonthAgo),
        partnersPct: pct(totalServiceVendors, vendorsMonthAgo),
        productsPct: pct(totalProducts, productsMonthAgo),
      },
    };
  }

  async getAnalytics(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const orders = await this.prisma.order.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, totalAmount: true, paymentStatus: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by day
    const byDay: Record<string, { date: string; orders: number; revenue: number }> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      byDay[key] = { date: key, orders: 0, revenue: 0 };
    }
    orders.forEach((o) => {
      const key = o.createdAt.toISOString().slice(0, 10);
      if (byDay[key]) {
        byDay[key].orders++;
        if (o.paymentStatus === 'PAID') byDay[key].revenue += Number(o.totalAmount || 0);
      }
    });

    // Order status breakdown
    const statusCounts: Record<string, number> = {};
    orders.forEach((o) => {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    });

    // "Top selling" must not count orders that never actually resulted in a sale.
    const sellableOrder = { status: { notIn: ['CANCELLED', 'REFUNDED'] as any[] } };

    // Top services
    const topServices = await this.prisma.order.groupBy({
      by: ['serviceId'],
      where: { createdAt: { gte: since }, serviceId: { not: null }, ...sellableOrder },
      _count: { id: true },
      _sum: { totalAmount: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });
    const svcDetails = await Promise.all(
      topServices.map(async (t) => {
        const svc = t.serviceId ? await this.prisma.service.findUnique({ where: { id: t.serviceId }, select: { name: true } }) : null;
        return { name: svc?.name || 'Unknown', orders: t._count?.id || 0, revenue: Number(t._sum?.totalAmount || 0) };
      }),
    );

    // Top products
    const topProductsRaw = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: { order: { createdAt: { gte: since }, ...sellableOrder } },
      _count: { id: true },
      _sum: { totalPrice: true, quantity: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });
    const prodDetails = await Promise.all(
      topProductsRaw.map(async (t) => {
        const prod = await this.prisma.product.findUnique({ where: { id: t.productId }, select: { name: true } });
        return { name: prod?.name || 'Unknown', units: t._sum?.quantity || 0, revenue: Number(t._sum?.totalPrice || 0) };
      }),
    );

    return {
      daily: Object.values(byDay),
      statusBreakdown: statusCounts,
      topServices: svcDetails,
      topProducts: prodDetails,
      totalOrders: orders.length,
      totalRevenue: orders.filter(o => o.paymentStatus === 'PAID').reduce((s, o) => s + Number(o.totalAmount || 0), 0),
    };
  }

  // ─── Users ──────────────────────────────────────────────────────────

  async listUsers(opts: { role?: UserRole; q?: string; limit?: number; offset?: number }) {
    return this.prisma.user.findMany({
      where: {
        ...(opts.role ? { role: opts.role } : {}),
        ...(opts.q ? { OR: [
          { name: { contains: opts.q, mode: 'insensitive' } },
          { phone: { contains: opts.q } },
          { email: { contains: opts.q, mode: 'insensitive' } },
        ]} : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
      select: { id: true, name: true, phone: true, email: true, role: true, language: true, isVerified: true, isBlocked: true, walletBalance: true, cityId: true, createdAt: true, lastLoginAt: true },
    });
  }

  async blockUser(id: string, block: boolean, actorId: string, actorRole: UserRole) {
    const updated = await this.prisma.user.update({ where: { id }, data: { isBlocked: block }, select: { id: true, name: true, phone: true, isBlocked: true } });
    await logAudit(this.prisma, { actorId, actorRole, action: block ? 'USER_BLOCKED' : 'USER_UNBLOCKED', targetType: 'User', targetId: id });
    return updated;
  }

  // Only a SUPER_ADMIN may grant a privileged role — these five roles can never be
  // self-provisioned through the public OTP endpoint (see auth.module.ts SELF_SIGNUP_ROLES),
  // so this is the only path to becoming an Admin, Delivery Partner, Corporate User, or CRM Agent.
  async setUserRole(actorId: string, actorRole: UserRole, targetId: string, newRole: UserRole) {
    if (actorRole !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a Super Admin can assign roles');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true } });
    if (!target) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { role: newRole },
      select: { id: true, name: true, phone: true, role: true },
    });
    await logAudit(this.prisma, {
      actorId, actorRole, action: 'ROLE_CHANGED', targetType: 'User', targetId,
      metadata: { from: target.role, to: newRole },
    });
    return updated;
  }

  async listAuditLogs(opts: { action?: string; limit?: number; offset?: number }) {
    return this.prisma.auditLog.findMany({
      where: opts.action ? { action: opts.action } : {},
      include: { actor: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
      skip: opts.offset || 0,
    });
  }

  async adjustWallet(id: string, amount: number, notes: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data: { walletBalance: { increment: amount } }, select: { walletBalance: true } });
      await tx.walletTransaction.create({
        data: { userId: id, type: amount >= 0 ? 'CREDIT' : 'DEBIT', reason: 'WALLET_TOPUP', amount: Math.abs(amount), balanceAfter: updated.walletBalance, notes: `Admin: ${notes}` },
      });
      return updated;
    });
  }

  // ─── Vendors ────────────────────────────────────────────────────────

  async pendingVendorApprovals() {
    return this.prisma.serviceVendor.findMany({
      where: { status: VendorStatus.PENDING_VERIFICATION },
      include: { user: { select: { name: true, phone: true, email: true } }, documents: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async allVendors(opts: { status?: VendorStatus; q?: string; limit?: number; agencyOwner?: boolean; agencyOwnerId?: string }) {
    return this.prisma.serviceVendor.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.q ? { OR: [{ fullName: { contains: opts.q, mode: 'insensitive' } }, { businessName: { contains: opts.q, mode: 'insensitive' } }] } : {}),
        ...(opts.agencyOwner ? { isAgencyOwner: true } : {}),
        ...(opts.agencyOwnerId ? { agencyOwnerId: opts.agencyOwnerId } : {}),
      },
      include: { user: { select: { name: true, phone: true, email: true } }, _count: { select: { members: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
    });
  }

  async approveVendor(vendorId: string) {
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { status: VendorStatus.ACTIVE } });
  }

  async rejectVendor(vendorId: string, reason: string) {
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { status: VendorStatus.REJECTED, rejectionReason: reason || null } });
  }

  async suspendVendor(vendorId: string) {
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { status: VendorStatus.SUSPENDED, isOnline: false } });
  }

  // Marks a vendor as in-house Remont staff vs an external partner — used by
  // RoutingService to prioritize in-house staff first for DIRECT_PARTNER services (Task 8).
  async setVendorStaffType(vendorId: string, staffType: 'IN_HOUSE' | 'PARTNER') {
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { staffType } });
  }

  // Full profile view for an already-approved vendor — previously the only detail view in
  // admin was PartnerRegistration's pre-approval record; once a vendor became active there
  // was no way to see their photo/documents/address/earnings/withdrawal history from admin
  // at all. Reuses existing data/services throughout — no new tracking, just a single read.
  async getVendorDetail(vendorId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({
      where: { id: vendorId },
      include: {
        user: { select: { name: true, phone: true, email: true } },
        documents: true,
        cityUpdateRequests: { orderBy: { createdAt: 'desc' }, take: 10 },
        bankUpdateRequests: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const [ledger, availableBalance, withdrawals] = await Promise.all([
      this.ledger.ledgerForVendor(vendorId, 20),
      this.ledger.availableBalance(vendorId),
      this.prisma.withdrawalRequest.findMany({ where: { vendorId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return { ...vendor, ledger, availableBalance, withdrawals };
  }

  // Full, downloadable financial history for one partner — getVendorDetail()'s own `ledger`
  // is capped at 20 rows for a fast detail-modal load; this is the uncapped version enriched
  // with each entry's related order so an accounting/finance download can actually reconcile
  // (payment mode, Remont's commission share, and the partner's own earning per job) instead
  // of just listing raw ledger amounts with no business context.
  async vendorLedgerForExport(vendorId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({
      where: { id: vendorId },
      select: { id: true, fullName: true, user: { select: { phone: true } } },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const entries = await this.ledger.ledgerForVendor(vendorId, 5000);
    const orderIds = Array.from(new Set(entries.map((e) => e.orderId).filter(Boolean))) as string[];
    const orders = orderIds.length
      ? await this.prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNumber: true, paymentMethod: true, totalAmount: true, remontCommission: true, vendorPayout: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));

    const rows = entries.map((e) => {
      const order = e.orderId ? orderById.get(e.orderId) : undefined;
      const amount = Number(e.amount);
      return {
        transactionId: e.id,
        date: e.createdAt,
        partnerId: vendor.id,
        partnerName: vendor.fullName,
        partnerPhone: vendor.user?.phone || '',
        orderId: e.orderId || '',
        orderNumber: order?.orderNumber || '',
        type: e.type,
        paymentMode: order?.paymentMethod || '',
        description: e.notes || '',
        credit: amount > 0 ? amount : '',
        debit: amount < 0 ? Math.abs(amount) : '',
        balanceAfter: Number(e.balanceAfter),
        remontAmount: order?.remontCommission != null ? Number(order.remontCommission) : '',
        partnerEarning: order?.vendorPayout != null ? Number(order.vendorPayout) : '',
        codCollection: order?.totalAmount != null && e.type === 'COD_COLLECTION' ? Number(order.totalAmount) : '',
        settlementRef: e.withdrawalRequestId || '',
      };
    });
    return { vendor: { id: vendor.id, name: vendor.fullName, phone: vendor.user?.phone || '' }, rows };
  }

  // ─── Vendor documents — verify/reject (nothing existed here before; a partner could
  // upload/reupload a document but no admin surface could ever act on it, so it sat at
  // verified:false forever) ────────────────────────────────────────────────────────────
  async verifyVendorDocument(docId: string) {
    const doc = await this.prisma.vendorDocument.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Document not found');
    const updated = await this.prisma.vendorDocument.update({ where: { id: docId }, data: { verified: true } });
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: doc.vendorId }, select: { userId: true } });
    if (vendor) this.events.emit('vendor.document.verified', { userId: vendor.userId, docType: doc.type });
    return updated;
  }

  async rejectVendorDocument(docId: string) {
    const doc = await this.prisma.vendorDocument.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Document not found');
    const updated = await this.prisma.vendorDocument.update({ where: { id: docId }, data: { verified: false } });
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: doc.vendorId }, select: { userId: true } });
    if (vendor) this.events.emit('vendor.document.rejected', { userId: vendor.userId, docType: doc.type });
    return updated;
  }

  // ─── Vendor city/address correction requests ───────────────────────────────────────
  async listCityUpdateRequests(status?: string) {
    return this.prisma.vendorCityUpdateRequest.findMany({
      where: status ? { status } : {},
      include: { vendor: { select: { fullName: true, baseCity: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveCityUpdate(id: string, adminId: string) {
    const req = await this.prisma.vendorCityUpdateRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already reviewed');
    // Only on approval does the requested city actually reach ServiceVendor.baseCity — a
    // rejected or still-pending request never touches the live profile.
    await this.prisma.$transaction([
      this.prisma.serviceVendor.update({ where: { id: req.vendorId }, data: { baseCity: req.requestedCity } }),
      this.prisma.vendorCityUpdateRequest.update({ where: { id }, data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date() } }),
    ]);
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'VENDOR_CITY_UPDATE_APPROVED', targetType: 'VendorCityUpdateRequest', targetId: id, metadata: { city: req.requestedCity } });
    const vendorForNotify = await this.prisma.serviceVendor.findUnique({ where: { id: req.vendorId }, select: { userId: true } });
    if (vendorForNotify) this.events.emit('vendor.cityUpdate.approved', { userId: vendorForNotify.userId, city: req.requestedCity });
    return this.prisma.vendorCityUpdateRequest.findUnique({ where: { id } });
  }

  async rejectCityUpdate(id: string, adminId: string) {
    const req = await this.prisma.vendorCityUpdateRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already reviewed');
    const updated = await this.prisma.vendorCityUpdateRequest.update({ where: { id }, data: { status: 'REJECTED', reviewedBy: adminId, reviewedAt: new Date() } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'VENDOR_CITY_UPDATE_REJECTED', targetType: 'VendorCityUpdateRequest', targetId: id });
    const vendorForNotify = await this.prisma.serviceVendor.findUnique({ where: { id: req.vendorId }, select: { userId: true } });
    if (vendorForNotify) this.events.emit('vendor.cityUpdate.rejected', { userId: vendorForNotify.userId, city: req.requestedCity });
    return updated;
  }

  // ─── Vendor Wallet: Base Hold + admin hold/release ─────────────────────
  // Base Hold is a pure withdrawal-floor threshold (see PartnerLedgerService.availableBalance)
  // — no ledger entry, just the stored field an admin can adjust per vendor.
  async setVendorBaseHold(vendorId: string, amount: number) {
    if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('Enter a valid, non-negative Base Hold amount');
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { baseHoldAmount: amount } });
  }

  async createAdminHold(vendorId: string, amount: number, adminId: string, notes?: string) {
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Enter a valid hold amount');
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return this.prisma.$transaction((tx) => this.ledger.postHold(tx, vendorId, 'ADMIN_MANUAL', amount, { createdBy: adminId, notes }));
  }

  async releaseHold(holdId: string, adminId: string) {
    return this.prisma.$transaction((tx) => this.ledger.releaseHold(tx, holdId, adminId));
  }

  async forfeitHold(holdId: string, reason?: string) {
    return this.prisma.$transaction((tx) => this.ledger.forfeitHold(tx, holdId, reason));
  }

  async extendHold(holdId: string, releaseDueAt: string) {
    const date = new Date(releaseDueAt);
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid release date');
    return this.prisma.partnerHold.update({ where: { id: holdId }, data: { releaseDueAt: date } });
  }

  // Closes a real gap: LedgerEntryType.ADJUSTMENT has existed in the schema since Phase 2 but
  // had no write path anywhere — a manual correction (a support goodwill credit, correcting a
  // data-entry mistake, clawing back an accidental overpayment) had no way to be recorded at
  // all. Mirrors createAdminHold's exact pattern: validate, post through the ledger inside one
  // transaction, keep pendingPayout in sync (increment works for both a positive credit and a
  // negative debit — Prisma's increment with a negative delta is a decrement).
  async postLedgerAdjustment(vendorId: string, amount: number, reason: string, adminId: string) {
    if (!Number.isFinite(amount) || amount === 0) throw new BadRequestException('Enter a non-zero adjustment amount (positive to credit, negative to debit)');
    if (!reason?.trim()) throw new BadRequestException('A reason is required for a manual ledger adjustment');
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const entry = await this.prisma.$transaction(async (tx) => {
      const posted = await this.ledger.postEntry(tx, vendorId, 'ADJUSTMENT', amount, { createdBy: adminId, notes: reason });
      await tx.serviceVendor.update({ where: { id: vendorId }, data: { pendingPayout: { increment: amount } } });
      return posted;
    });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'VENDOR_LEDGER_ADJUSTMENT', targetType: 'ServiceVendor', targetId: vendorId, metadata: { amount, reason } });
    return entry;
  }

  async vendorHolds(vendorId: string) {
    return this.prisma.partnerHold.findMany({ where: { vendorId }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  // ─── Phase 2: Agency Partner Management ────────────────────────────
  // Same shape as approveVendor/suspendVendor above — an agency owner is just a
  // ServiceVendor with isAgencyOwner:true, so these are targeted additions next
  // to the vendor-lifecycle methods that already do this exact kind of work.

  async approveAgency(vendorId: string, adminId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    if (!vendor.isAgencyOwner) throw new BadRequestException('This partner is not registered as an agency');
    const updated = await this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { agencyStatus: 'ACTIVE', status: VendorStatus.ACTIVE } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'AGENCY_APPROVED', targetType: 'ServiceVendor', targetId: vendorId });
    this.events.emit('agency.approved', { userId: vendor.userId, vendorId });
    return updated;
  }

  // Members keep working independently while their agency is suspended — the spec
  // states members "work exactly like Individual Service Partners after approval,"
  // so suspending the agency shouldn't silently pull already-approved workers offline.
  async suspendAgency(vendorId: string, adminId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    if (!vendor.isAgencyOwner) throw new BadRequestException('This partner is not registered as an agency');
    const updated = await this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { agencyStatus: 'SUSPENDED' } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'AGENCY_SUSPENDED', targetType: 'ServiceVendor', targetId: vendorId });
    this.events.emit('agency.suspended', { userId: vendor.userId, vendorId });
    return updated;
  }

  async freezeMember(vendorId: string, adminId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    if (!vendor.agencyOwnerId) throw new BadRequestException('This partner is not an agency team member');
    const updated = await this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { memberStatus: 'FROZEN', isOnline: false } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'MEMBER_FROZEN', targetType: 'ServiceVendor', targetId: vendorId });
    this.events.emit('member.frozen', { userId: vendor.userId, vendorId });
    return updated;
  }

  async unfreezeMember(vendorId: string, adminId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    if (!vendor.agencyOwnerId) throw new BadRequestException('This partner is not an agency team member');
    const updated = await this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { memberStatus: 'ACTIVE' } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'MEMBER_UNFROZEN', targetType: 'ServiceVendor', targetId: vendorId });
    this.events.emit('member.unfrozen', { userId: vendor.userId, vendorId });
    return updated;
  }

  async transferMember(vendorId: string, newAgencyOwnerId: string, adminId: string) {
    const [member, newOwner] = await Promise.all([
      this.prisma.serviceVendor.findUnique({ where: { id: vendorId } }),
      this.prisma.serviceVendor.findUnique({ where: { id: newAgencyOwnerId } }),
    ]);
    if (!member) throw new NotFoundException('Partner not found');
    if (!member.agencyOwnerId) throw new BadRequestException('This partner is not an agency team member');
    if (!newOwner || !newOwner.isAgencyOwner) throw new BadRequestException('Target is not an active agency owner');
    const updated = await this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { agencyOwnerId: newAgencyOwnerId } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'MEMBER_TRANSFERRED', targetType: 'ServiceVendor', targetId: vendorId, metadata: { fromAgencyOwnerId: member.agencyOwnerId, toAgencyOwnerId: newAgencyOwnerId } });
    this.events.emit('member.transferred', { userId: member.userId, vendorId });
    return updated;
  }

  // Admin-wide view of Stage F's per-day attendance — the agency-owner-scoped
  // equivalent lives on AgencyController (vendors.module.ts) since that one is
  // self-service; this is the "or all (for admin)" half of the same spec line.
  async vendorAttendance(dateStr?: string, agencyOwnerId?: string) {
    const date = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    date.setHours(0, 0, 0, 0);
    const where: any = { date };
    if (agencyOwnerId) where.vendor = { OR: [{ id: agencyOwnerId }, { agencyOwnerId }] };
    return this.prisma.vendorAttendance.findMany({
      where,
      include: { vendor: { select: { fullName: true, isAgencyOwner: true, agencyOwnerId: true } } },
      orderBy: { checkInAt: 'desc' },
    });
  }

  async approveWithdrawal(id: string, adminId: string, note?: string) {
    const req = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Withdrawal request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already reviewed');
    // Hands off to the existing, unchanged settlement-recording flow instead of
    // re-implementing "pay a vendor" — record() already atomically decrements pendingPayout
    // AND posts the matching WITHDRAWAL ledger entry (tagged with this withdrawalRequestId),
    // so there's no separate follow-up ledger post here anymore (that used to happen as a
    // second, non-atomic transaction after this one).
    const settlement = await this.settlements.record(req.vendorId, Number(req.amount), SettlementMode.BANK_TRANSFER, adminId, undefined, note, id);
    await this.prisma.withdrawalRequest.update({ where: { id }, data: { status: 'PAID', reviewedBy: adminId, reviewNote: note || null, reviewedAt: new Date(), settlementId: settlement.id } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'WITHDRAWAL_APPROVED', targetType: 'WithdrawalRequest', targetId: id, metadata: { amount: req.amount } });
    const vendorForNotify = await this.prisma.serviceVendor.findUnique({ where: { id: req.vendorId }, select: { userId: true } });
    if (vendorForNotify) this.events.emit('withdrawal.approved', { userId: vendorForNotify.userId, amount: Number(req.amount), withdrawalId: id });
    return this.prisma.withdrawalRequest.findUnique({ where: { id } });
  }

  async rejectWithdrawal(id: string, adminId: string, note?: string) {
    const req = await this.prisma.withdrawalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Withdrawal request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already reviewed');
    const updated = await this.prisma.withdrawalRequest.update({ where: { id }, data: { status: 'REJECTED', reviewedBy: adminId, reviewNote: note || null, reviewedAt: new Date() } });
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'WITHDRAWAL_REJECTED', targetType: 'WithdrawalRequest', targetId: id });
    const vendorForNotify = await this.prisma.serviceVendor.findUnique({ where: { id: req.vendorId }, select: { userId: true } });
    if (vendorForNotify) this.events.emit('withdrawal.rejected', { userId: vendorForNotify.userId, amount: Number(req.amount), withdrawalId: id, note });
    return updated;
  }

  // Permanent removal — SUPER_ADMIN only at the route level. Regular admins use
  // suspendVendor() + createDeleteRequest() instead; see the Delete Request workflow below.
  async deleteServiceVendorDirect(vendorId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    return this.prisma.serviceVendor.delete({ where: { id: vendorId } });
  }

  // ─── Product Vendors (Sellers) ────────────────────────────────────────
  // Admin-managed only for this phase — no public self-registration.
  // See PROJECT_ROADMAP.md "Phase 1" for the hybrid seller model this implements.

  async listProductVendors(opts: { status?: VendorStatus; q?: string; limit?: number }) {
    return this.prisma.productVendor.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.q ? { businessName: { contains: opts.q, mode: 'insensitive' } } : {}),
      },
      include: {
        user: { select: { name: true, phone: true, email: true, isBlocked: true } },
        _count: { select: { products: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
    });
  }

  async createProductVendor(data: CreateProductVendorDto) {
    const existingUser = await this.prisma.user.findUnique({ where: { phone: data.phone } });
    if (existingUser && existingUser.role !== UserRole.CUSTOMER && existingUser.role !== UserRole.PRODUCT_VENDOR) {
      throw new BadRequestException(`This phone number is already registered as ${existingUser.role}`);
    }
    if (existingUser?.role === UserRole.PRODUCT_VENDOR) {
      const already = await this.prisma.productVendor.findUnique({ where: { userId: existingUser.id } });
      if (already) throw new BadRequestException('A seller account already exists for this phone number');
    }

    // Admin-provisioned, same as AdminService.setUserRole(): upsert the User directly with
    // the target role, isVerified:true. The seller then logs in through the normal
    // /auth/send-otp + /auth/verify-otp flow — no separate password system needed for sellers.
    const user = await this.prisma.user.upsert({
      where: { phone: data.phone },
      update: { role: UserRole.PRODUCT_VENDOR, isVerified: true, name: data.name },
      create: { phone: data.phone, name: data.name, role: UserRole.PRODUCT_VENDOR, isVerified: true },
    });

    return this.prisma.productVendor.create({
      data: {
        userId: user.id,
        businessName: data.businessName,
        gstNumber: data.gstNumber || null,
        city: data.city || null,
        address: data.address || null,
        pickupAddress: data.pickupAddress || null,
        status: VendorStatus.ACTIVE,
      },
      include: { user: { select: { name: true, phone: true } } },
    });
  }

  async updateProductVendor(id: string, data: UpdateProductVendorDto) {
    return this.prisma.productVendor.update({
      where: { id },
      data,
      include: { user: { select: { name: true, phone: true } } },
    });
  }

  async suspendProductVendor(id: string) {
    return this.prisma.productVendor.update({ where: { id }, data: { status: VendorStatus.SUSPENDED } });
  }

  // Permanent removal — SUPER_ADMIN only at the route level. Regular admins use
  // suspendProductVendor() + createDeleteRequest() instead.
  async deleteProductVendorDirect(id: string) {
    const seller = await this.prisma.productVendor.findUnique({ where: { id } });
    if (!seller) throw new NotFoundException('Seller not found');
    return this.prisma.productVendor.delete({ where: { id } });
  }

  async activateProductVendor(id: string) {
    return this.prisma.productVendor.update({ where: { id }, data: { status: VendorStatus.ACTIVE } });
  }

  // ─── Orders ─────────────────────────────────────────────────────────

  async orderStats() {
    const [total, newOrders, active, completed, cancelled, revenue, stuck] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] } } }),
      this.prisma.order.count({ where: { status: { in: ['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'] } } }),
      this.prisma.order.count({ where: { status: 'COMPLETED' } }),
      this.prisma.order.count({ where: { status: 'CANCELLED' } }),
      this.prisma.order.aggregate({ _sum: { totalAmount: true }, where: { paymentStatus: 'PAID' } }),
      // Confirmed, unassigned, at least one dispatch wave already went out with no
      // takers — the count backing the admin "stuck orders" queue badge.
      this.prisma.order.count({ where: { status: 'CONFIRMED', vendorId: null, dispatchAttempts: { gte: 1 } } }),
    ]);
    return { total, new: newOrders, active, completed, cancelled, revenue: Number(revenue._sum.totalAmount || 0), stuck };
  }

  async listOrders(opts: { status?: string; city?: string; q?: string; channel?: string; limit?: number; offset?: number; stuck?: boolean; invoiceFailed?: boolean }) {
    const where: any = {
      // "Stuck" = confirmed, unassigned, and at least one auto-dispatch wave already
      // went out with nobody accepting — the admin queue this powers is exactly the
      // "orders vendors keep declining/ignoring" list, so an admin can call someone
      // directly and force-assign via listActiveVendors()/forceAssignVendor().
      ...(opts.stuck ? { status: OrderStatus.CONFIRMED, vendorId: null, dispatchAttempts: { gte: 1 } } : {}),
      // Completed orders whose auto-invoice generation threw and was never retried
      // successfully — see invoiceGenerationFailed on Order and generateInvoice() above,
      // which is the idempotent retry action for this exact queue.
      ...(opts.invoiceFailed ? { invoiceGenerationFailed: true } : {}),
      ...(opts.status ? { status: opts.status as OrderStatus } : {}),
      ...(opts.channel ? { channel: opts.channel as any } : {}),
      ...(opts.city ? { address: { city: { contains: opts.city, mode: 'insensitive' } } } : {}),
      ...(opts.q ? {
        OR: [
          { orderNumber: { contains: opts.q, mode: 'insensitive' } },
          { guestPhone: { contains: opts.q, mode: 'insensitive' } },
          { guestName: { contains: opts.q, mode: 'insensitive' } },
          { customer: { phone: { contains: opts.q, mode: 'insensitive' } } },
          { customer: { name: { contains: opts.q, mode: 'insensitive' } } },
        ],
      } : {}),
    };
    return this.prisma.order.findMany({
      where,
      include: {
        customer: { select: { name: true, phone: true } },
        vendor: { select: { id: true, fullName: true, staffType: true, user: { select: { name: true, phone: true } } } },
        service: { select: { name: true, basePrice: true, durationMinutes: true, fulfillmentType: true } },
        serviceItems: { include: { service: { select: { name: true, basePrice: true } } } },
        address: { select: { city: true, fullAddress: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ? Number(opts.limit) : 100,
      skip: opts.offset ? Number(opts.offset) : 0,
    });
  }

  async adminGetOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true, walletBalance: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        service: { include: { category: { select: { name: true } } } },
        serviceItems: { include: { service: { include: { category: { select: { name: true } } } } } },
        address: true,
        items: { include: { product: { select: { name: true, sku: true, images: true } } } },
        extraWorkItems: true,
        invoice: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Billing classification + explicit partner-vs-Remont revenue split, shown as two
    // visually distinct blocks in the admin order detail screen — the partner's amount
    // must never be presented as Remont's own revenue (see billing-engine.ts). Reads the
    // frozen value off the invoice once one exists; otherwise resolves live from the
    // order's current type/vendor staffing, which is what will actually get frozen once
    // an invoice is generated.
    const transactionType = order.invoice?.transactionType || resolveBillingTransactionType(order.type, order.vendor?.staffType);
    const partnerAmount = Number(order.serviceAmount) + order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
    const remontRevenue = transactionType === 'DIRECT_PROJECT'
      ? Number(order.subtotal)
      : Number(order.remontCommission) + Number(order.platformCharges);
    const billing = {
      transactionType,
      partnerAmount: transactionType === 'PLATFORM_SERVICE' ? partnerAmount : 0,
      remontRevenue,
      note: transactionType === 'PLATFORM_SERVICE'
        ? 'Partner amount is settled to the partner and is not Remont revenue — only the platform fee is.'
        : transactionType === 'MARKETPLACE_PRODUCT'
          ? 'Product sale value belongs to the seller — only Remont\'s marketplace commission (if any) is Remont revenue.'
          : 'Remont fulfils this order directly — the full value is Remont revenue.',
    };
    return { ...order, billing };
  }

  async adminCreateOrder(data: {
    serviceId: string; cityId: string; slotDate: string; slotTime: string;
    guestName: string; guestPhone: string; guestEmail?: string;
    fullAddress: string; notes?: string; channel?: string; leadId?: string;
  }) {
    const svc = await this.prisma.service.findUnique({ where: { id: data.serviceId } });
    if (!svc) throw new NotFoundException('Service not found');
    const city = await this.prisma.city.findUnique({ where: { id: data.cityId } });
    if (!city) throw new NotFoundException('City not found');

    let user = await this.prisma.user.findUnique({ where: { phone: data.guestPhone } });
    if (!user) {
      user = await this.prisma.user.create({
        data: { phone: data.guestPhone, name: data.guestName, role: 'CUSTOMER', isVerified: false },
      });
    }

    const cityPrice = await this.cities.getServicePrice(city.name, data.serviceId);
    const serviceAmount = cityPrice !== null ? cityPrice : Number(svc.basePrice);
    const commissionResult = await resolveCommission(this.prisma, {
      serviceId: svc.id, categoryId: svc.categoryId, cityId: city.id, amount: serviceAmount,
    });
    const gstAmount = Math.round(serviceAmount * 0.18 * 100) / 100;

    const [h, m] = data.slotTime.split(':').map(Number);
    const slotStart = new Date(data.slotDate); slotStart.setHours(h, m || 0, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + svc.durationMinutes * 60000);

    const address = await this.prisma.address.create({
      data: { userId: user.id, label: 'Booking', fullAddress: data.fullAddress, city: city.name, state: city.state, pincode: '000000', latitude: city.latitude, longitude: city.longitude, isDefault: false },
    });

    const count = await this.prisma.order.count();
    const orderNumber = (await import('../../common')).generateOrderNumber('REM', count);
    const order = await this.prisma.order.create({
      data: {
        orderNumber, customerId: user.id, serviceId: data.serviceId, addressId: address.id,
        type: 'SERVICE', channel: (data.channel as any) || 'CRM_AGENT',
        status: 'CONFIRMED', paymentStatus: 'PENDING',
        guestName: data.guestName, guestPhone: data.guestPhone, guestEmail: data.guestEmail || null,
        adminNotes: data.notes || null, slotStart, slotEnd,
        startOtp: Math.floor(1000 + Math.random() * 9000).toString(),
        serviceAmount, productsAmount: 0, subtotal: serviceAmount,
        couponDiscount: 0, membershipDiscount: 0, walletUsed: 0,
        gstAmount, totalAmount: serviceAmount + gstAmount,
        remontCommission: commissionResult.commissionAmount,
        vendorPayout: serviceAmount - commissionResult.commissionAmount,
        commissionRuleId: commissionResult.ruleId,
        commissionRuleLabel: commissionResult.ruleLabel,
        leadId: data.leadId || undefined,
      },
      include: { service: true, address: true, customer: { select: { name: true, phone: true } } },
    });
    // Convert-to-Order (admin Leads console) — link back and flip the lead's funnel
    // status, closing the gap where Lead.convertedAt/convertedOrderId were permanently
    // unused columns (nothing ever called CrmService.markConverted() before this).
    if (data.leadId) await this.crm.markConverted(data.leadId, order.id);
    return order;
  }

  async forceAssignVendor(orderId: string, vendorId: string, actorId?: string, actorRole?: UserRole) {
    // Every automated routing/dispatch path (RoutingService, DispatchService,
    // availableJobs/acceptJob) already refuses to touch a product-only order — this was
    // the one unguarded path: an admin opening the "Assign Vendor" (Service Partner)
    // panel on a pure-product order could force-assign it, even firing the same
    // job.offer.created notification a real service job would. A Service Partner is
    // never the right recipient for a product order — that belongs to the Product's
    // own ProductVendor/Seller (see ProductVendorsService.myOrders()).
    const existing = await this.prisma.order.findUnique({ where: { id: orderId }, select: { serviceId: true } });
    if (!existing) throw new NotFoundException();
    if (!existing.serviceId) {
      throw new BadRequestException('This order has no service — a Service Partner cannot be assigned to a product-only order.');
    }
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { vendorId, status: OrderStatus.VENDOR_ASSIGNED },
      include: { vendor: { include: { user: { select: { name: true, phone: true } } } }, service: true, address: true },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.VENDOR_ASSIGNED, actorId, actorRole, note: 'Force-assigned by admin' });
    // Previously this silently set vendorId with no notification of any kind — the
    // vendor only ever found out by happening to check their job list. Now goes
    // through the same ring/push/WhatsApp-fallback path as auto-routed jobs.
    if (updated.vendor) {
      this.events.emit('job.offer.created', { vendorUserId: updated.vendor.userId, orderId: updated.id, order: updated });
    }
    return updated;
  }

  async adminUpdateStatus(orderId: string, status: string, note?: string, actorId?: string, actorRole?: UserRole) {
    const validStatuses = ['PENDING_PAYMENT', 'CONFIRMED', 'VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED', 'COMPLETED', 'INVOICED', 'CLOSED', 'CANCELLED', 'REFUNDED'];
    if (!validStatuses.includes(status)) throw new BadRequestException(`Invalid status: ${status}`);
    const data: any = { status };
    if (note) data.adminNotes = note;
    if (status === 'COMPLETED') data.completedAt = new Date();
    if (status === 'CANCELLED') { data.cancelledAt = new Date(); if (note) data.cancelReason = note; }
    if (status === 'REFUNDED') data.paymentStatus = 'REFUNDED';
    const updated = await this.prisma.order.update({ where: { id: orderId }, data });
    await writeOrderTimeline(this.prisma, { orderId, status, note, actorId, actorRole });
    if (status === 'COMPLETED') this.autoGenerateInvoice(orderId).catch(() => {});
    return updated;
  }

  private async autoGenerateInvoice(orderId: string) {
    await this.invoices.generateForOrder(orderId);
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'INVOICED' as any } });
  }

  async adminUpdateNote(orderId: string, note: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { adminNotes: note } });
  }

  // "Live vendors" for the admin to call/assign directly — mirrors DispatchService's
  // isOnline + ACTIVE + not-FROZEN eligibility so what an admin sees to hand-assign is
  // never a superset of who auto-dispatch would actually ring. Passing orderId sorts by
  // distance to that order's address (nearest first, like DispatchService's scoring) so
  // the admin can just call down the list; without it, falls back to rating-desc.
  //
  // Production incident: a Vadodara Plumbing job's manual-assign list showed vendors from
  // every city and every category — this method only ever filtered on status/online/skill
  // (and only IF a `skill` param happened to be passed, which the admin frontend never
  // did), then just SORTED the unfiltered result by distance with no cutoff. Now the
  // order's own category is read directly (never left to an optional query param) and
  // normalized the same way DispatchService.dispatch() normalizes it, and every candidate
  // is run through the SAME isVendorLocationEligible() rule dispatch/isEligibleForOrder use
  // — so this list is never a superset of who the system would actually offer the job to.
  async listActiveVendors(skill?: string, orderId?: string) {
    const normalizedSkillParam = skill ? normalizeSkillKey(skill) : undefined;

    if (!orderId) {
      return this.prisma.serviceVendor.findMany({
        where: {
          status: 'ACTIVE',
          isOnline: true,
          ...NOT_FROZEN_MEMBER_FILTER, // excludes a frozen agency member; null (non-agency) vendors stay eligible
          ...(normalizedSkillParam ? { skills: { has: normalizedSkillParam } } : {}),
        },
        include: { user: { select: { name: true, phone: true } } },
        orderBy: { rating: 'desc' },
        take: 100,
      });
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { address: true, service: { include: { category: { select: { key: true } } } } },
    });
    // A product-only order has no Service Partner to assign at all — same rule
    // forceAssignVendor() enforces, applied here too so the admin UI never even offers a
    // vendor list for one.
    if (!order?.serviceId) return [];

    // The order's own category is the authoritative required skill — an explicit `skill`
    // param is only a fallback for the rare case the category can't be resolved, never
    // allowed to override/broaden what this specific job actually needs.
    const requiredSkill = order.service?.category?.key
      ? normalizeSkillKey(order.service.category.key)
      : normalizedSkillParam;

    // Scale fix: same gap DispatchService.dispatch() had — this previously fetched up to
    // 100 skill-matching online vendors NATIONWIDE with no geographic filter at all, then
    // filtered/sorted in-app. Once the nationwide pool for a given skill exceeds 100, the
    // real eligible nearby vendor for this order could simply never be among the rows
    // fetched. Prefilter at the DB level the same way dispatch does: a generous lat/lng
    // bounding box when the order has real GPS, else the vendor's own city, before the
    // in-app isVendorLocationEligible() exact check runs on a now-bounded candidate set.
    const lat = order.address?.latitude, lng = order.address?.longitude;
    const hasOrderCoords = isValidIndiaCoords(lat, lng);
    const geoWhere = hasOrderCoords
      ? (() => {
          const box = boundingBoxForRadius(lat!, lng!, MAX_DISPATCH_RADIUS_KM);
          return { currentLatitude: { gte: box.minLat, lte: box.maxLat }, currentLongitude: { gte: box.minLng, lte: box.maxLng } };
        })()
      : order.address?.city
        ? { baseCity: { equals: order.address.city, mode: 'insensitive' as const } }
        : {};

    const vendors = await this.prisma.serviceVendor.findMany({
      where: {
        status: 'ACTIVE',
        isOnline: true,
        ...NOT_FROZEN_MEMBER_FILTER,
        ...(requiredSkill ? { skills: { has: requiredSkill } } : {}),
        ...geoWhere,
      },
      include: { user: { select: { name: true, phone: true } } },
      take: 200,
    });

    const eligible = vendors.filter((v) => isVendorLocationEligible(v, order));

    if (!hasOrderCoords) return eligible.sort((a, b) => b.rating - a.rating);

    return eligible
      .map((v) => ({
        ...v,
        distanceKm: v.currentLatitude != null && v.currentLongitude != null
          ? Math.round(haversineKm(lat!, lng!, v.currentLatitude, v.currentLongitude) * 10) / 10
          : null,
      }))
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }

  async adminCancelOrder(orderId: string, reason: string, actorId?: string, actorRole?: UserRole) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    // Same Lead Cost refund guard as OrdersService.cancel() (orders.module.ts) — "admin
    // approves" from the spec maps to this admin-initiated cancel path. The updateMany()
    // compare-and-swap on leadCostRefunded (rather than a plain read-then-write) is what
    // actually prevents a double-refund if this races the customer cancel path for the same
    // order — see the race-condition fix comment on OrdersService.cancel().
    const updated = await this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: `Admin: ${reason}`, adminNotes: reason } });
      if (order?.vendorId && Number(order.leadCostAmount) > 0) {
        const claimed = await tx.order.updateMany({
          where: { id: orderId, leadCostRefunded: false },
          data: { leadCostRefunded: true },
        });
        if (claimed.count === 1) {
          await this.ledger.refundLeadCost(tx, order.vendorId, orderId, Number(order.leadCostAmount));
          await tx.serviceVendor.update({ where: { id: order.vendorId }, data: { pendingPayout: { increment: Number(order.leadCostAmount) } } });
        }
      }
      return cancelled;
    });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.CANCELLED, note: reason, actorId, actorRole });
    return updated;
  }

  async refundOrder(orderId: string, reason: string, actorId?: string, actorRole?: UserRole) {
    const updated = await this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.REFUNDED, paymentStatus: 'REFUNDED', cancelReason: `REFUND: ${reason}`, adminNotes: reason } });
    await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.REFUNDED, note: reason, actorId, actorRole });
    return updated;
  }

  // ─── Cities ─────────────────────────────────────────────────────────

  async createCity(data: { name: string; state: string; latitude: number; longitude: number; pincodes?: string[]; isActive?: boolean; activeServiceKeys?: string[] }) {
    return this.prisma.city.create({ data: { ...data, pincodes: data.pincodes || [], activeServiceKeys: data.activeServiceKeys || [] } });
  }

  async updateCity(name: string, data: { state?: string; latitude?: number; longitude?: number; pincodes?: string[]; isActive?: boolean; activeServiceKeys?: string[]; priceMultiplier?: number }) {
    return this.prisma.city.update({ where: { name }, data });
  }

  async toggleCityActive(cityName: string, isActive: boolean) {
    return this.prisma.city.update({ where: { name: cityName }, data: { isActive } });
  }

  async listCities() {
    return this.prisma.city.findMany({ orderBy: { name: 'asc' } });
  }

  // Bulk activation — the single-city toggleCityActive() above still works for one-off
  // changes; these cover "activate multiple", "activate all", "deactivate all" from the
  // admin city-management UI without needing a code change or redeploy per city.
  async bulkToggleCities(cityNames: string[], isActive: boolean) {
    return this.prisma.city.updateMany({ where: { name: { in: cityNames } }, data: { isActive } });
  }

  async toggleAllCities(isActive: boolean) {
    return this.prisma.city.updateMany({ data: { isActive } });
  }

  // Per-city counts for the admin city-management dashboard. Sellers/technicians are matched
  // by their stored city string against City.name (case-insensitive) — the same loose-matching
  // approach already used elsewhere in this codebase (e.g. vendors.module.ts availableJobs()).
  async cityStats() {
    const cities = await this.prisma.city.findMany({ orderBy: { name: 'asc' } });
    const [sellers, technicians, products] = await Promise.all([
      this.prisma.productVendor.findMany({ where: { city: { not: null } }, select: { city: true } }),
      this.prisma.serviceVendor.findMany({ select: { baseCity: true } }),
      this.prisma.product.findMany({ where: { vendor: { city: { not: null } } }, select: { vendor: { select: { city: true } } } }),
    ]);

    const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();
    const countBy = <T,>(items: T[], keyFn: (item: T) => string) => {
      const map = new Map<string, number>();
      for (const item of items) {
        const key = keyFn(item);
        if (!key) continue;
        map.set(key, (map.get(key) || 0) + 1);
      }
      return map;
    };
    const sellerMap = countBy(sellers, (s) => norm(s.city));
    const technicianMap = countBy(technicians, (t) => norm(t.baseCity));
    const productMap = countBy(products, (p) => norm(p.vendor?.city));

    const perCity = cities.map((c) => ({
      name: c.name,
      isActive: c.isActive,
      sellerCount: sellerMap.get(norm(c.name)) || 0,
      technicianCount: technicianMap.get(norm(c.name)) || 0,
      productCount: productMap.get(norm(c.name)) || 0,
      serviceAvailability: (c.activeServiceKeys || []).length,
    }));

    const activeCities = cities.filter((c) => c.isActive).length;
    return {
      totalCities: cities.length,
      activeCities,
      inactiveCities: cities.length - activeCities,
      launchMode: activeCities <= 1 ? 'SINGLE_CITY' : 'MULTI_CITY',
      cities: perCity,
    };
  }

  // ─── Service Categories ──────────────────────────────────────────────

  async listAllCategories() {
    return this.prisma.serviceCategory.findMany({
      include: { services: { where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, basePrice: true, originalPrice: true, durationMinutes: true, isPopular: true } } },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createCategory(data: any) {
    const slug = data.slug || slugify(data.name);
    return this.prisma.serviceCategory.create({ data: { ...data, slug, seoKeywords: data.seoKeywords || [] } });
  }

  async updateCategory(id: string, data: any) {
    const existing = await this.prisma.serviceCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    if (data.name && !data.slug) data.slug = slugify(data.name);
    return this.prisma.serviceCategory.update({ where: { id }, data });
  }

  async deleteCategory(id: string) {
    const svcCount = await this.prisma.service.count({ where: { categoryId: id } });
    if (svcCount > 0) throw new BadRequestException(`Cannot delete: ${svcCount} services use this category. Disable it instead.`);
    return this.prisma.serviceCategory.delete({ where: { id } });
  }

  async forceDeleteCategory(id: string) {
    const cat = await this.prisma.serviceCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Category not found');
    const services = await this.prisma.service.findMany({ where: { categoryId: id }, select: { id: true } });
    const svcIds = services.map(s => s.id);
    if (svcIds.length > 0) {
      await this.prisma.order.updateMany({ where: { serviceId: { in: svcIds } }, data: { serviceId: null } });
      await this.prisma.cityService.deleteMany({ where: { serviceId: { in: svcIds } } });
      await this.prisma.service.deleteMany({ where: { id: { in: svcIds } } });
    }
    await this.prisma.serviceCategory.delete({ where: { id } });
    return { deleted: true, categoryName: cat.name, servicesRemoved: svcIds.length };
  }

  async bulkUpdateCategories(ids: string[], data: { isActive?: boolean }) {
    return this.prisma.serviceCategory.updateMany({ where: { id: { in: ids } }, data });
  }

  // ─── Sub-Categories ───────────────────────────────────────────────────

  async listSubCategories(categoryId?: string) {
    return this.prisma.subCategory.findMany({
      where: categoryId ? { categoryId } : {},
      include: { category: { select: { name: true, key: true } }, _count: { select: { services: true } } },
      orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async createSubCategory(data: any) {
    const slug = data.slug || slugify(data.name);
    return this.prisma.subCategory.create({ data: { ...data, slug }, include: { category: true } });
  }

  async updateSubCategory(id: string, data: any) {
    const existing = await this.prisma.subCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sub-category not found');
    if (data.name && !data.slug) data.slug = slugify(data.name);
    return this.prisma.subCategory.update({ where: { id }, data, include: { category: true } });
  }

  async deleteSubCategory(id: string) {
    const svcCount = await this.prisma.service.count({ where: { subCategoryId: id } });
    if (svcCount > 0) throw new BadRequestException(`Cannot delete: ${svcCount} services use this sub-category. Disable it instead.`);
    return this.prisma.subCategory.delete({ where: { id } });
  }

  async bulkUpdateSubCategories(ids: string[], data: { isActive?: boolean }) {
    return this.prisma.subCategory.updateMany({ where: { id: { in: ids } }, data });
  }

  // ─── Services ───────────────────────────────────────────────────────

  async listAllServices(opts: { categoryId?: string; q?: string; isActive?: boolean; limit?: number; offset?: number } = {}) {
    return this.prisma.service.findMany({
      where: {
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
        ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: 'insensitive' } }, { description: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      include: { category: { select: { name: true, key: true } }, subCategory: { select: { name: true, key: true } }, cityServices: { select: { cityId: true, isActive: true, customPrice: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 200,
      skip: opts.offset || 0,
    });
  }

  async createService(data: any) {
    const slug = slugify(data.name) + '-' + Date.now();
    const { cities, ...rest } = data;
    return this.prisma.service.create({
      data: { ...rest, slug, requiredSkills: rest.requiredSkills || [], images: rest.images || [], seoKeywords: rest.seoKeywords || [] },
      include: { category: true, subCategory: true },
    });
  }

  async updateService(id: string, data: any) {
    const existing = await this.prisma.service.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Service not found');
    const { cities, ...rest } = data;
    return this.prisma.service.update({ where: { id }, data: rest, include: { category: true, subCategory: true } });
  }

  async deleteService(id: string) {
    const orderCount = await this.prisma.order.count({ where: { serviceId: id } });
    if (orderCount > 0) return this.prisma.service.update({ where: { id }, data: { isActive: false } });
    return this.prisma.service.delete({ where: { id } });
  }

  // Regular admins use this instead of deleteService() directly.
  async suspendService(id: string) {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw new NotFoundException('Service not found');
    return this.prisma.service.update({ where: { id }, data: { isActive: false } });
  }

  // ─── Service Pricing (Admin → Service Pricing screen) ─────────────────
  // Per-service, per-city, per-tier price sheet. STANDARD-tier rows feed real
  // checkout pricing via CitiesService.getServicePrice() — see that method's doc
  // comment for the full precedence chain. All money fields are validated here,
  // server-side, never trusting whatever the admin form happened to send.

  async listServicePricing(q?: string) {
    return this.prisma.servicePricing.findMany({
      where: q ? { service: { name: { contains: q, mode: 'insensitive' } } } : {},
      include: { service: { select: { id: true, name: true } }, city: { select: { id: true, name: true } } },
      orderBy: [{ service: { name: 'asc' } }, { tier: 'asc' }],
    });
  }

  /** Shared validation for create/update — never trust client-supplied money/duration values. */
  private validateServicePricingInput(data: any) {
    const basePrice = Number(data.basePrice);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      throw new BadRequestException('Base price must be a positive number');
    }
    let discountedPrice: number | null | undefined = undefined;
    if (data.discountedPrice !== undefined && data.discountedPrice !== null && data.discountedPrice !== '') {
      discountedPrice = Number(data.discountedPrice);
      if (!Number.isFinite(discountedPrice) || discountedPrice <= 0) {
        throw new BadRequestException('Discounted price must be a positive number');
      }
      if (discountedPrice > basePrice) {
        throw new BadRequestException('Discounted price cannot be higher than the base price');
      }
    } else if (data.discountedPrice === null || data.discountedPrice === '') {
      discountedPrice = null; // explicit clear
    }
    let duration: number | null | undefined = undefined;
    if (data.duration !== undefined && data.duration !== null && data.duration !== '') {
      duration = Number(data.duration);
      if (!Number.isInteger(duration) || duration <= 0) {
        throw new BadRequestException('Duration must be a positive whole number of minutes');
      }
    } else if (data.duration === null || data.duration === '') {
      duration = null;
    }
    const tier = data.tier && ['STANDARD', 'PREMIUM', 'ECONOMY'].includes(data.tier) ? data.tier : 'STANDARD';
    return { basePrice, discountedPrice, duration, tier };
  }

  async createServicePricing(data: any) {
    if (!data.serviceId) throw new BadRequestException('Service is required');
    const service = await this.prisma.service.findUnique({ where: { id: data.serviceId } });
    if (!service) throw new NotFoundException('Service not found');
    const cityId = data.cityId || null;
    if (cityId) {
      const city = await this.prisma.city.findUnique({ where: { id: cityId } });
      if (!city) throw new NotFoundException('City not found');
    }
    const { basePrice, discountedPrice, duration, tier } = this.validateServicePricingInput(data);

    const existing = await this.prisma.servicePricing.findFirst({ where: { serviceId: data.serviceId, cityId, tier } });
    if (existing) {
      throw new BadRequestException(`A ${tier} pricing row already exists for this service in ${cityId ? 'this city' : 'All Cities'} — edit it instead of creating a duplicate`);
    }

    return this.prisma.servicePricing.create({
      data: { serviceId: data.serviceId, cityId, tier, basePrice, discountedPrice: discountedPrice ?? undefined, duration: duration ?? undefined },
      include: { service: { select: { id: true, name: true } }, city: { select: { id: true, name: true } } },
    });
  }

  async updateServicePricing(id: string, data: any) {
    const existing = await this.prisma.servicePricing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Pricing row not found');

    const serviceId = data.serviceId || existing.serviceId;
    if (data.serviceId) {
      const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) throw new NotFoundException('Service not found');
    }
    const cityId = data.cityId !== undefined ? (data.cityId || null) : existing.cityId;
    if (cityId) {
      const city = await this.prisma.city.findUnique({ where: { id: cityId } });
      if (!city) throw new NotFoundException('City not found');
    }
    const { basePrice, discountedPrice, duration, tier } = this.validateServicePricingInput({
      basePrice: data.basePrice !== undefined ? data.basePrice : existing.basePrice,
      discountedPrice: data.discountedPrice !== undefined ? data.discountedPrice : existing.discountedPrice,
      duration: data.duration !== undefined ? data.duration : existing.duration,
      tier: data.tier || existing.tier,
    });

    const dup = await this.prisma.servicePricing.findFirst({ where: { serviceId, cityId, tier, id: { not: id } } });
    if (dup) {
      throw new BadRequestException(`A ${tier} pricing row already exists for this service in ${cityId ? 'this city' : 'All Cities'}`);
    }

    return this.prisma.servicePricing.update({
      where: { id },
      data: { serviceId, cityId, tier, basePrice, discountedPrice, duration },
      include: { service: { select: { id: true, name: true } }, city: { select: { id: true, name: true } } },
    });
  }

  async deleteServicePricing(id: string) {
    const existing = await this.prisma.servicePricing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Pricing row not found');
    return this.prisma.servicePricing.delete({ where: { id } });
  }

  // ─── Delete Requests — regular admins request, SUPER_ADMIN approves ──────

  private async resolveDeleteTargetLabel(targetType: DeleteTargetType, targetId: string): Promise<string> {
    if (targetType === DeleteTargetType.SERVICE_VENDOR) {
      const v = await this.prisma.serviceVendor.findUnique({ where: { id: targetId } });
      if (!v) throw new NotFoundException('Partner not found');
      return v.businessName || v.fullName;
    }
    if (targetType === DeleteTargetType.PRODUCT_VENDOR) {
      const v = await this.prisma.productVendor.findUnique({ where: { id: targetId } });
      if (!v) throw new NotFoundException('Seller not found');
      return v.businessName;
    }
    const s = await this.prisma.service.findUnique({ where: { id: targetId } });
    if (!s) throw new NotFoundException('Service not found');
    return s.name;
  }

  private async hardDeleteTarget(targetType: DeleteTargetType, targetId: string) {
    if (targetType === DeleteTargetType.SERVICE_VENDOR) return this.deleteServiceVendorDirect(targetId);
    if (targetType === DeleteTargetType.PRODUCT_VENDOR) return this.deleteProductVendorDirect(targetId);
    return this.deleteService(targetId);
  }

  async createDeleteRequest(requestedBy: string, targetType: DeleteTargetType, targetId: string, reason?: string) {
    const targetLabel = await this.resolveDeleteTargetLabel(targetType, targetId);
    // Suspend immediately — a pending delete request should stop the entity from
    // being used/booked while it's awaiting the master admin's decision.
    if (targetType === DeleteTargetType.SERVICE_VENDOR) await this.suspendVendor(targetId);
    if (targetType === DeleteTargetType.PRODUCT_VENDOR) await this.suspendProductVendor(targetId);
    if (targetType === DeleteTargetType.SERVICE) await this.suspendService(targetId);
    return this.prisma.deleteRequest.create({
      data: { targetType, targetId, targetLabel, reason: reason || null, requestedBy },
    });
  }

  async listDeleteRequests(status?: string) {
    return this.prisma.deleteRequest.findMany({
      where: status ? { status: status as any } : {},
      include: {
        requester: { select: { name: true, phone: true } },
        reviewer: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveDeleteRequest(id: string, reviewedBy: string, reviewNote?: string) {
    const req = await this.prisma.deleteRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Delete request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already reviewed');
    await this.hardDeleteTarget(req.targetType, req.targetId);
    const updated = await this.prisma.deleteRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewedBy, reviewNote: reviewNote || null, reviewedAt: new Date() },
    });
    await logAudit(this.prisma, {
      actorId: reviewedBy, actorRole: UserRole.SUPER_ADMIN, action: 'DELETE_REQUEST_APPROVED',
      targetType: req.targetType, targetId: req.targetId, metadata: { deleteRequestId: id, reviewNote },
    });
    return updated;
  }

  async rejectDeleteRequest(id: string, reviewedBy: string, reviewNote?: string) {
    const req = await this.prisma.deleteRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Delete request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already reviewed');
    const updated = await this.prisma.deleteRequest.update({
      where: { id },
      data: { status: 'REJECTED', reviewedBy, reviewNote: reviewNote || null, reviewedAt: new Date() },
    });
    await logAudit(this.prisma, {
      actorId: reviewedBy, actorRole: UserRole.SUPER_ADMIN, action: 'DELETE_REQUEST_REJECTED',
      targetType: req.targetType, targetId: req.targetId, metadata: { deleteRequestId: id, reviewNote },
    });
    return updated;
  }

  async bulkUpdateServices(ids: string[], data: { isActive?: boolean }) {
    return this.prisma.service.updateMany({ where: { id: { in: ids } }, data });
  }

  async deleteAllOrders() {
    await this.prisma.review.deleteMany({});
    await this.prisma.invoice.deleteMany({});
    const result = await this.prisma.order.deleteMany({});
    return { deleted: result.count };
  }

  async deleteAllServices() {
    await this.prisma.cityService.deleteMany({});
    const result = await this.prisma.service.deleteMany({});
    return { deleted: result.count };
  }

  // City-wise service assignment
  async listServiceCities(serviceId: string) {
    const cities = await this.prisma.city.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    const assignments = await this.prisma.cityService.findMany({ where: { serviceId } });
    const map = new Map(assignments.map((a) => [a.cityId, a]));
    return cities.map((c) => ({ ...c, assignment: map.get(c.id) || null }));
  }

  async upsertServiceCity(serviceId: string, cityId: string, data: { isActive: boolean; customPrice?: number | null }) {
    return this.prisma.cityService.upsert({
      where: { cityId_serviceId: { cityId, serviceId } },
      create: { cityId, serviceId, isActive: data.isActive, customPrice: data.customPrice ?? null },
      update: { isActive: data.isActive, customPrice: data.customPrice ?? null },
    });
  }

  async exportServices() {
    return this.prisma.service.findMany({
      include: { category: { select: { name: true, key: true } } },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  // ─── Product Categories ──────────────────────────────────────────────

  async listProductCategories() {
    return this.prisma.productCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async createProductCategory(data: { key: string; name: string; icon?: string; sortOrder?: number }) {
    return this.prisma.productCategory.create({ data });
  }

  async updateProductCategory(id: string, data: { name?: string; icon?: string; sortOrder?: number; isActive?: boolean }) {
    return this.prisma.productCategory.update({ where: { id }, data });
  }

  async deleteProductCategory(id: string) {
    const count = await this.prisma.product.count({ where: { categoryId: id } });
    if (count > 0) throw new BadRequestException(`Cannot delete: ${count} products in this category`);
    return this.prisma.productCategory.delete({ where: { id } });
  }

  // ─── Products ───────────────────────────────────────────────────────

  async adminListProducts(opts: { q?: string; categoryId?: string; isActive?: boolean; lowStock?: boolean; limit?: number; offset?: number }) {
    return this.prisma.product.findMany({
      where: {
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
        // Same low-stock threshold already used elsewhere (seller dashboard's lowStockCount,
        // vendors.module.ts:509, and seller.html:583) — kept consistent rather than inventing
        // a second, different definition of "low stock" for the admin view.
        ...(opts.lowStock ? { stock: { lte: 5 } } : {}),
        ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: 'insensitive' } }, { sku: { contains: opts.q, mode: 'insensitive' } }, { brand: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      include: {
        vendor: { select: { businessName: true, status: true } },
        category: { select: { name: true, key: true } },
        _count: { select: { cityProducts: { where: { isActive: true } } } },
      },
      orderBy: opts.lowStock ? { stock: 'asc' } : { createdAt: 'desc' },
      take: opts.limit || 100,
      skip: opts.offset || 0,
    });
  }

  async adminCreateProduct(data: any) {
    const slug = slugify(data.name) + '-' + Date.now();
    const sku = data.sku || 'RMNT-' + Date.now();
    // cityIds isn't a Product column — it drives CityProduct rows via the products module's
    // syncCityCoverage (same helper the seller-facing create/update endpoints use).
    const { cityIds, ...productData } = data;
    const product = await this.prisma.product.create({
      data: { ...productData, slug, sku, images: data.images || [], seoKeywords: data.seoKeywords || [], aiEnhancedImgs: [] },
      include: { category: { select: { name: true } } },
    });
    if ((data.coverageType === 'SELECTED_CITIES' || data.coverageType === 'ZONES') && Array.isArray(cityIds)) {
      await this.syncProductCityCoverage(product.id, cityIds);
    }
    return product;
  }

  async adminUpdateProduct(id: string, data: any) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    const { cityIds, ...productData } = data;
    const updated = await this.prisma.product.update({ where: { id }, data: productData, include: { category: { select: { name: true } } } });
    if ((data.coverageType === 'SELECTED_CITIES' || data.coverageType === 'ZONES') && Array.isArray(cityIds)) {
      await this.syncProductCityCoverage(id, cityIds);
    }
    return updated;
  }

  // Same replace-semantics helper as ProductsService.syncCityCoverage in products.module.ts
  // (duplicated rather than cross-module-imported — these are separate domain modules by
  // this codebase's established single-file-per-module convention).
  async syncProductCityCoverage(productId: string, cityIds: string[]) {
    const existing = await this.prisma.cityProduct.findMany({ where: { productId } });
    const desired = new Set(cityIds);
    for (const e of existing) {
      if (!desired.has(e.cityId) && e.isActive) {
        await this.prisma.cityProduct.update({ where: { id: e.id }, data: { isActive: false } });
      }
    }
    for (const cityId of cityIds) {
      await this.prisma.cityProduct.upsert({
        where: { cityId_productId: { cityId, productId } },
        create: { cityId, productId, isActive: true },
        update: { isActive: true },
      });
    }
  }

  async adminDeleteProduct(id: string) {
    const orderCount = await this.prisma.orderItem.count({ where: { productId: id } });
    if (orderCount > 0) return this.prisma.product.update({ where: { id }, data: { isActive: false } });
    return this.prisma.product.delete({ where: { id } });
  }

  async bulkUpdateProducts(ids: string[], data: { isActive?: boolean }) {
    return this.prisma.product.updateMany({ where: { id: { in: ids } }, data });
  }

  // City-wise product assignment
  async listProductCities(productId: string) {
    const cities = await this.prisma.city.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    const assignments = await this.prisma.cityProduct.findMany({ where: { productId } });
    const map = new Map(assignments.map((a) => [a.cityId, a]));
    return cities.map((c) => ({ ...c, assignment: map.get(c.id) || null }));
  }

  async upsertProductCity(productId: string, cityId: string, data: { isActive: boolean; customPrice?: number | null; stock?: number }) {
    return this.prisma.cityProduct.upsert({
      where: { cityId_productId: { cityId, productId } },
      create: { cityId, productId, isActive: data.isActive, customPrice: data.customPrice ?? null, stock: data.stock ?? 0 },
      update: { isActive: data.isActive, customPrice: data.customPrice ?? null, stock: data.stock ?? 0 },
    });
  }

  async exportProducts() {
    return this.prisma.product.findMany({
      include: { category: { select: { name: true, key: true } } },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  // ─── AI Content Generation ───────────────────────────────────────────

  async generateAiContent(type: 'SERVICE' | 'PRODUCT' | 'CATEGORY', name: string, context?: string): Promise<{
    description: string; seoTitle: string; seoDesc: string; seoKeywords: string[];
    inclusions?: string[]; exclusions?: string[]; faq: { q: string; a: string }[];
  }> {
    if (this.openaiKey) {
      try {
        const prompt = `Generate content for a Remont India home services listing:
Type: ${type}
Name: ${name}
${context ? `Context: ${context}` : ''}

Return JSON with:
- description: 2-3 sentence customer-friendly, conversion-focused professional description (60-80 words)
- seoTitle: strong SEO title, 50-60 characters exactly. Include the literal token "{city}" where a
  city name would naturally go (e.g. "${name} in {city} | Remont India") so the SAME title can be
  reused for every city we serve just by substituting the token — never hardcode one specific city.
- seoDesc: meta description, 150-160 characters exactly. Also include "{city}" if a city name
  would naturally appear, for the same reason.
- seoKeywords: array of 5-8 relevant, SEO-optimized keywords
- inclusions: array of 4-6 short bullet points of what's included in this service/product
- exclusions: array of 2-4 short bullet points of what's NOT included (e.g. spare parts, materials, exclusions)
- faq: array of 4 objects with {q, a} — common customer questions and answers`;

        const raw = await openAiComplete(this.openaiKey, this.openaiModel, [
          { role: 'system', content: 'You are a marketing copywriter for Remont India home services. Return only valid JSON.' },
          { role: 'user', content: prompt },
        ], { maxTokens: 500, jsonMode: true });
        return parseAiJson(raw);
      } catch (e) {
        this.logger.warn(`AI content generation failed, using template: ${e.message}`);
      }
    }

    // Fallback: template-based content
    const description = `Experience premium ${name} by Remont India's certified professionals. Our experts use industry-grade equipment and follow quality-checked processes to deliver exceptional results. Book in minutes, get service at your doorstep — 100% satisfaction guaranteed.`;
    // {city} is a literal template token, substituted client-side per the customer's
    // selected city (see _applyServiceCitySeo() in index.html) — never one hardcoded city.
    const seoTitle = `${name} in {city} | Remont India`.slice(0, 60);
    const seoDesc = `Book ${name} in {city} with Remont India. Certified professionals, doorstep service, 100% satisfaction guarantee, GST invoice.`.slice(0, 160);
    const seoKeywords = [name.toLowerCase(), 'home service', 'doorstep service', 'remont india', 'book online', `${name.toLowerCase()} price`, `best ${name.toLowerCase()}`];
    const inclusions = [
      `Professional ${name} by a certified technician`,
      'Pre-service inspection and diagnosis',
      'Standard tools and equipment',
      'Post-service quality check',
      'Digital service report',
    ];
    const exclusions = [
      'Spare parts and replacement materials (charged separately, on approval)',
      'Structural or civil work beyond the scope of this service',
    ];
    const faq = [
      { q: `How long does ${name} take?`, a: 'Our certified technicians typically complete the service in 60–90 minutes depending on the scope of work.' },
      { q: `Is ${name} available in my city?`, a: 'We are available in Mumbai, Delhi, Bangalore, Hyderabad, Pune, Chennai, Kolkata, Ahmedabad, Jaipur, Lucknow, and Indore.' },
      { q: `What is included in ${name}?`, a: `The ${name} package includes a thorough inspection, cleaning, repair if required, and a service report. All work is backed by a 30-day service guarantee.` },
      { q: `How do I book ${name}?`, a: 'Visit remontindia.com, select your city and service, choose a time slot, and pay online. Our professional will arrive at the scheduled time.' },
    ];
    return { description, seoTitle, seoDesc, seoKeywords, inclusions, exclusions, faq };
  }

  /**
   * "Generate for all empty services" — one click fills the 196/222 services that
   * already have a basic description but zero SEO/inclusions content (or any other
   * still-missing field), without touching services an admin has already filled in
   * manually. Bounded to `limit` per call (default 20) so one HTTP request can't run
   * long enough to time out against 200+ services — the admin button just reports how
   * many are left and can be clicked again.
   */
  async bulkGenerateAiContent(limit = 20) {
    const services = await this.prisma.service.findMany({
      where: {
        OR: [
          { seoTitle: null }, { seoTitle: '' },
          { inclusions: { equals: [] } },
        ],
      },
      take: limit,
    });
    let processed = 0;
    for (const svc of services) {
      try {
        const ai = await this.generateAiContent('SERVICE', svc.name);
        await this.prisma.service.update({
          where: { id: svc.id },
          data: {
            description: svc.description || ai.description,
            seoTitle: svc.seoTitle || ai.seoTitle,
            seoDesc: svc.seoDesc || ai.seoDesc,
            seoKeywords: svc.seoKeywords?.length ? svc.seoKeywords : ai.seoKeywords,
            inclusions: svc.inclusions?.length ? svc.inclusions : (ai.inclusions || []),
            exclusions: svc.exclusions?.length ? svc.exclusions : (ai.exclusions || []),
            faqJson: (svc.faqJson as any) || ai.faq,
          },
        });
        processed++;
      } catch (e) {
        this.logger.warn(`Bulk AI generate failed for service ${svc.id}: ${e.message}`);
      }
    }
    const remaining = await this.prisma.service.count({
      where: { OR: [{ seoTitle: null }, { seoTitle: '' }, { inclusions: { equals: [] } }] },
    });
    return { processed, remaining };
  }

  // ─── Banners (CMS) ──────────────────────────────────────────────────

  async listBanners() {
    return this.prisma.homeBanner.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async createBanner(data: { title: string; subtitle?: string; ctaText?: string; ctaUrl?: string; imageUrl?: string; bgColor?: string; tag?: string; sortOrder?: number; cityFilter?: string[] }) {
    return this.prisma.homeBanner.create({ data: { ...data, cityFilter: data.cityFilter || [] } });
  }

  async updateBanner(id: string, data: { title?: string; subtitle?: string; ctaText?: string; ctaUrl?: string; imageUrl?: string; bgColor?: string; tag?: string; sortOrder?: number; isActive?: boolean; cityFilter?: string[] }) {
    return this.prisma.homeBanner.update({ where: { id }, data });
  }

  async deleteBanner(id: string) {
    return this.prisma.homeBanner.delete({ where: { id } });
  }

  // ─── Commission Rules (Task 9) ───────────────────────────────────────
  // CRUD for CommissionRule; actual resolution logic lives in resolveCommission()
  // (common/index.ts), shared with every order-creation path so admin edits here
  // take effect on the NEXT booking without touching past orders (which keep their
  // snapshotted commissionRuleId/commissionRuleLabel — see Order in schema.prisma).

  async listCommissionRules(scope?: string, categoryId?: string, serviceId?: string, cityId?: string) {
    return this.prisma.commissionRule.findMany({
      where: {
        ...(scope ? { scope: scope as any } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(cityId ? { cityId } : {}),
      },
      include: {
        category: { select: { name: true } },
        service: { select: { name: true } },
        city: { select: { name: true } },
      },
      orderBy: [{ scope: 'asc' }, { priority: 'desc' }],
    });
  }

  async createCommissionRule(data: any) {
    if (data.scope === 'CATEGORY' && !data.categoryId) throw new BadRequestException('categoryId is required for a CATEGORY-scoped rule');
    if (data.scope === 'SERVICE' && !data.serviceId) throw new BadRequestException('serviceId is required for a SERVICE-scoped rule');
    return this.prisma.commissionRule.create({ data });
  }

  async updateCommissionRule(id: string, data: any) {
    const existing = await this.prisma.commissionRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Commission rule not found');
    return this.prisma.commissionRule.update({ where: { id }, data });
  }

  async deleteCommissionRule(id: string) {
    return this.prisma.commissionRule.delete({ where: { id } });
  }

  // Admin preview: "This service, this city -> commission = ₹X (rule: ...)" — reuses
  // the exact same resolveCommission() every real order goes through.
  async previewCommission(serviceId: string, cityName?: string, amount?: number) {
    const svc = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!svc) throw new NotFoundException('Service not found');
    let cityId: string | null = null;
    if (cityName) {
      const city = await this.cities.getByName(cityName);
      cityId = city?.id || null;
    }
    const testAmount = amount ?? Number(svc.basePrice);
    const result = await resolveCommission(this.prisma, { serviceId, categoryId: svc.categoryId, cityId, amount: testAmount });
    return { serviceName: svc.name, amount: testAmount, ...result };
  }

  // ─── Site Settings ───────────────────────────────────────────────────

  async getSettings(group?: string) {
    return this.prisma.siteSetting.findMany({ where: group ? { group } : {} });
  }

  async upsertSetting(key: string, value: string, label?: string, group?: string) {
    return this.prisma.siteSetting.upsert({
      where: { key },
      create: { key, value, label: label || key, group: group || 'general' },
      update: { value },
    });
  }

  // ─── Seed initial data ───────────────────────────────────────────────

  async seedData() {
    const results: string[] = [];

    // Cities
    const cities = [
      { name: 'Mumbai', state: 'Maharashtra', latitude: 19.0760, longitude: 72.8777, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE','INTERIOR','RENOVATION','CONSTRUCTION','CLEANING'] },
      { name: 'Delhi NCR', state: 'Delhi', latitude: 28.6139, longitude: 77.2090, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE','INTERIOR','RENOVATION','CONSTRUCTION','CLEANING'] },
      { name: 'Bangalore', state: 'Karnataka', latitude: 12.9716, longitude: 77.5946, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE','INTERIOR','RENOVATION','CLEANING'] },
      { name: 'Hyderabad', state: 'Telangana', latitude: 17.3850, longitude: 78.4867, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE','INTERIOR','CLEANING'] },
      { name: 'Pune', state: 'Maharashtra', latitude: 18.5204, longitude: 73.8567, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE','RENOVATION','CLEANING'] },
      { name: 'Chennai', state: 'Tamil Nadu', latitude: 13.0827, longitude: 80.2707, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE','CLEANING'] },
      { name: 'Kolkata', state: 'West Bengal', latitude: 22.5726, longitude: 88.3639, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','CLEANING'] },
      { name: 'Ahmedabad', state: 'Gujarat', latitude: 23.0225, longitude: 72.5714, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL','APPLIANCE'] },
      { name: 'Jaipur', state: 'Rajasthan', latitude: 26.9124, longitude: 75.7873, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL'] },
      { name: 'Lucknow', state: 'Uttar Pradesh', latitude: 26.8467, longitude: 80.9462, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL'] },
      { name: 'Indore', state: 'Madhya Pradesh', latitude: 22.7196, longitude: 75.8577, activeServiceKeys: ['AC_SERVICE','PLUMBING','ELECTRICAL'] },
    ];
    for (const c of cities) {
      await this.prisma.city.upsert({ where: { name: c.name }, create: { ...c, pincodes: [] }, update: { activeServiceKeys: c.activeServiceKeys } });
    }
    results.push(`✓ ${cities.length} cities upserted`);

    // Service categories
    const categories = [
      { key: 'AC_SERVICE', name: 'AC Service & Repair', icon: '❄️', sortOrder: 1 },
      { key: 'PLUMBING', name: 'Plumbing', icon: '🚿', sortOrder: 2 },
      { key: 'ELECTRICAL', name: 'Electrical', icon: '💡', sortOrder: 3 },
      { key: 'APPLIANCE', name: 'Appliance Repair', icon: '📺', sortOrder: 4 },
      { key: 'CLEANING', name: 'Home Cleaning', icon: '🧹', sortOrder: 5 },
      { key: 'INTERIOR', name: 'Interior Design', icon: '🛋️', sortOrder: 6, isPremium: true },
      { key: 'RENOVATION', name: 'Renovation', icon: '🔨', sortOrder: 7, isPremium: true },
      { key: 'CONSTRUCTION', name: 'Construction', icon: '🏗️', sortOrder: 8, isPremium: true },
    ];
    const catMap: Record<string, string> = {};
    for (const cat of categories) {
      const c = await this.prisma.serviceCategory.upsert({ where: { key: cat.key }, create: { ...cat, isPremium: (cat as any).isPremium || false }, update: { name: cat.name, icon: cat.icon } });
      catMap[cat.key] = c.id;
    }
    results.push(`✓ ${categories.length} service categories upserted`);

    // Services
    const services = [
      { catKey: 'AC_SERVICE', name: 'AC Installation (1 Ton)', basePrice: 999, originalPrice: 1499, durationMinutes: 120, isPopular: true },
      { catKey: 'AC_SERVICE', name: 'AC Gas Refill', basePrice: 2199, originalPrice: 2999, durationMinutes: 60, isPopular: true },
      { catKey: 'AC_SERVICE', name: 'AC Deep Cleaning', basePrice: 599, originalPrice: 899, durationMinutes: 90 },
      { catKey: 'AC_SERVICE', name: 'AC Repair & Diagnosis', basePrice: 399, originalPrice: 599, durationMinutes: 60, isPopular: true },
      { catKey: 'PLUMBING', name: 'Tap & Leak Repair', basePrice: 199, originalPrice: 399, durationMinutes: 30, isPopular: true },
      { catKey: 'PLUMBING', name: 'Toilet Installation', basePrice: 1499, originalPrice: 1999, durationMinutes: 120 },
      { catKey: 'PLUMBING', name: 'Pipe Replacement', basePrice: 499, originalPrice: 799, durationMinutes: 60 },
      { catKey: 'PLUMBING', name: 'Bathroom Renovation', basePrice: 65000, originalPrice: 85000, durationMinutes: 4320, isPremium: true },
      { catKey: 'ELECTRICAL', name: 'Switch & Socket Repair', basePrice: 199, originalPrice: 299, durationMinutes: 30, isPopular: true },
      { catKey: 'ELECTRICAL', name: 'Light / Fan Installation', basePrice: 299, originalPrice: 399, durationMinutes: 45 },
      { catKey: 'ELECTRICAL', name: 'Wiring & Conduit Work', basePrice: 499, originalPrice: 699, durationMinutes: 120 },
      { catKey: 'ELECTRICAL', name: 'Smart Home Setup', basePrice: 4999, originalPrice: 6999, durationMinutes: 240, isPremium: true },
      { catKey: 'APPLIANCE', name: 'TV Repair', basePrice: 399, originalPrice: 599, durationMinutes: 60, isPopular: true },
      { catKey: 'APPLIANCE', name: 'Refrigerator Repair', basePrice: 499, originalPrice: 799, durationMinutes: 90, isPopular: true },
      { catKey: 'APPLIANCE', name: 'Washing Machine Repair', basePrice: 399, originalPrice: 599, durationMinutes: 60 },
      { catKey: 'APPLIANCE', name: 'Microwave / Oven Repair', basePrice: 399, originalPrice: 599, durationMinutes: 60 },
      { catKey: 'CLEANING', name: 'Full Home Deep Cleaning', basePrice: 1499, originalPrice: 2499, durationMinutes: 240, isPopular: true },
      { catKey: 'CLEANING', name: 'Sofa & Carpet Shampooing', basePrice: 599, originalPrice: 899, durationMinutes: 120 },
      { catKey: 'CLEANING', name: 'Pest Control', basePrice: 799, originalPrice: 1299, durationMinutes: 120, isPopular: true },
      { catKey: 'CLEANING', name: 'Glass & Facade Cleaning', basePrice: 999, originalPrice: 1599, durationMinutes: 180 },
      { catKey: 'INTERIOR', name: 'Full Home Interior Design', basePrice: 200000, originalPrice: 300000, durationMinutes: 43200, isPremium: true },
      { catKey: 'INTERIOR', name: 'Bedroom Makeover', basePrice: 85000, originalPrice: 120000, durationMinutes: 20160, isPremium: true },
      { catKey: 'RENOVATION', name: 'Modular Kitchen', basePrice: 120000, originalPrice: 150000, durationMinutes: 20160, isPremium: true },
      { catKey: 'RENOVATION', name: 'Full Home Renovation', basePrice: 400000, originalPrice: 600000, durationMinutes: 60480, isPremium: true },
      { catKey: 'CONSTRUCTION', name: 'New Build Construction', basePrice: 150000, originalPrice: 200000, durationMinutes: 259200, isPremium: true },
      { catKey: 'CONSTRUCTION', name: 'Free Site Visit & Quote', basePrice: 0, originalPrice: 2000, durationMinutes: 60 },
    ];
    let svcCount = 0;
    for (const s of services) {
      const catId = catMap[s.catKey];
      if (!catId) continue;
      const slug = slugify(s.name) + '-' + catId.slice(-6);
      await this.prisma.service.upsert({
        where: { slug },
        create: { categoryId: catId, name: s.name, slug, basePrice: s.basePrice, originalPrice: s.originalPrice, durationMinutes: s.durationMinutes, isPopular: s.isPopular || false, isPremium: s.isPremium || false, requiredSkills: [s.catKey] },
        update: { basePrice: s.basePrice, originalPrice: s.originalPrice },
      });
      svcCount++;
    }
    results.push(`✓ ${svcCount} services upserted`);

    // Product categories
    const prodCats = [
      { key: 'AC_PRODUCTS', name: 'AC & Cooling', icon: '❄️' },
      { key: 'ELECTRICAL_PRODUCTS', name: 'Electrical & Lighting', icon: '💡' },
      { key: 'PLUMBING_PRODUCTS', name: 'Plumbing & Bath', icon: '🚿' },
      { key: 'APPLIANCES', name: 'Appliances', icon: '📺' },
      { key: 'FURNITURE', name: 'Furniture & Interior', icon: '🛋️' },
      { key: 'CLEANING_SUPPLIES', name: 'Cleaning Supplies', icon: '🧹' },
      { key: 'CONSTRUCTION_MATERIALS', name: 'Construction Materials', icon: '🏗️' },
    ];
    for (const pc of prodCats) {
      await this.prisma.productCategory.upsert({ where: { key: pc.key }, create: pc, update: { name: pc.name } });
    }
    results.push(`✓ ${prodCats.length} product categories upserted`);

    // Default banners
    const banners = [
      { title: "India's Smartest Home Service Platform", subtitle: "Tell our AI what's wrong — we auto-match the best vendor near you", ctaText: "Try AI Chat Booking", ctaUrl: "#ai-chat", tag: "AI-Powered", sortOrder: 1 },
      { title: "AC Service Starting ₹399", subtitle: "Expert AC technicians at your doorstep in 60 minutes", ctaText: "Book Now", ctaUrl: "#ac", tag: "Summer Offer", sortOrder: 2 },
      { title: "AMC Plans — Unlimited Service Calls", subtitle: "One annual plan. Unlimited repairs. Full home coverage.", ctaText: "View AMC Plans", ctaUrl: "#amc", tag: "New Launch", sortOrder: 3 },
    ];
    for (const b of banners) {
      const existing = await this.prisma.homeBanner.findFirst({ where: { title: b.title } });
      if (!existing) await this.prisma.homeBanner.create({ data: { ...b, cityFilter: [] } });
    }
    results.push(`✓ Default banners created`);

    // Default settings
    const settings = [
      { key: 'site_name', value: 'Remont', label: 'Site / Brand Name', group: 'general' },
      { key: 'site_tagline', value: 'India', label: 'Site Tagline (shown beside logo)', group: 'general' },
      { key: 'site_description', value: "India's AI-powered multi-service marketplace. Handyman, interior, construction, AMC — booked via app, web, WhatsApp, AI chat, or call.", label: 'Site Description (footer)', group: 'general' },
      { key: 'logo_url', value: '', label: 'Logo Image URL (leave blank to use default icon)', group: 'general' },
      { key: 'support_phone', value: '+91 98765 43210', label: 'Support Phone', group: 'contact' },
      { key: 'support_email', value: 'support@remontindia.com', label: 'Support Email', group: 'contact' },
      { key: 'support_label', value: '24/7 AI Chat Support', label: 'Support Hours Label', group: 'contact' },
      { key: 'whatsapp_number', value: '+919876543210', label: 'WhatsApp Number', group: 'contact' },
      { key: 'social_linkedin', value: '', label: 'LinkedIn URL', group: 'social' },
      { key: 'social_instagram', value: '', label: 'Instagram URL', group: 'social' },
      { key: 'social_twitter', value: '', label: 'Twitter / X URL', group: 'social' },
      { key: 'social_youtube', value: '', label: 'YouTube URL', group: 'social' },
      { key: 'social_facebook', value: '', label: 'Facebook URL', group: 'social' },
      { key: 'total_cities', value: '32', label: 'Total Cities (shown on homepage)', group: 'stats' },
      { key: 'total_reviews', value: '50000', label: 'Total Reviews (shown on homepage)', group: 'stats' },
      { key: 'total_vendors', value: '5000', label: 'Total Vendors (shown on homepage)', group: 'stats' },
      { key: 'otp_regen_max_attempts', value: '0', label: 'Max "Request OTP Again" attempts per service (0 = unlimited)', group: 'operations' },
    ];
    for (const s of settings) {
      await this.prisma.siteSetting.upsert({ where: { key: s.key }, create: s, update: {} });
    }
    results.push(`✓ Default settings upserted`);

    return { success: true, results };
  }

  // ─── Enhanced global stats ───────────────────────────────────────────
  async fullStats() {
    const base = await this.globalStats();
    const [
      totalReviews, avgRating,
      totalNewsletters, activeCoupons, totalBlogPosts, publishedBlogs,
      totalFaqs, activeFaqs, totalOrders, completedOrders, cancelledOrders, activeOrders,
      primeMembers, totalServices, inactiveServices,
    ] = await Promise.all([
      this.prisma.review.count(),
      this.prisma.review.aggregate({ _avg: { rating: true } }),
      this.prisma.newsletter.count({ where: { isActive: true } }).catch(() => 0),
      this.prisma.coupon.count({ where: { isActive: true } }),
      this.prisma.blogPost.count().catch(() => 0),
      this.prisma.blogPost.count({ where: { isPublished: true } }).catch(() => 0),
      this.prisma.faq.count().catch(() => 0),
      this.prisma.faq.count({ where: { isActive: true } }).catch(() => 0),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: 'COMPLETED' } }),
      this.prisma.order.count({ where: { status: 'CANCELLED' } }),
      this.prisma.order.count({ where: { status: { in: ['CONFIRMED','VENDOR_ASSIGNED','VENDOR_EN_ROUTE','IN_PROGRESS'] } } }),
      this.prisma.userMembership.count({ where: { isActive: true } }),
      this.prisma.service.count({ where: { isActive: true } }),
      this.prisma.service.count({ where: { isActive: false } }),
    ]);
    return {
      ...base,
      reviews: { total: totalReviews, avgRating: avgRating._avg.rating || 0 },
      newsletters: { total: totalNewsletters },
      coupons: { active: activeCoupons },
      blogs: { total: totalBlogPosts, published: publishedBlogs },
      faqs: { total: totalFaqs, active: activeFaqs },
      orders: {
        ...base.orders,
        total: totalOrders, completed: completedOrders, cancelled: cancelledOrders, active: activeOrders,
      },
      members: { prime: primeMembers },
      services: { active: totalServices, inactive: inactiveServices },
    };
  }

  // ─── Newsletters ─────────────────────────────────────────────────────

  async listNewsletters(opts: { q?: string; limit?: number; offset?: number }) {
    return this.prisma.newsletter.findMany({
      where: opts.q ? { OR: [{ email: { contains: opts.q, mode: 'insensitive' } }, { name: { contains: opts.q, mode: 'insensitive' } }] } : {},
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
      skip: opts.offset || 0,
    }).catch(() => []);
  }

  async deleteNewsletter(id: string) {
    return this.prisma.newsletter.delete({ where: { id } }).catch(() => null);
  }

  async exportNewsletters() {
    const list = await this.prisma.newsletter.findMany({ where: { isActive: true }, select: { email: true, name: true, source: true, createdAt: true } }).catch(() => []);
    return list;
  }

  // ─── FAQs ─────────────────────────────────────────────────────────────

  async listFaqs(category?: string) {
    return this.prisma.faq.findMany({
      where: category ? { category } : {},
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    }).catch(() => []);
  }

  async createFaq(data: { question: string; answer: string; category?: string; sortOrder?: number }) {
    return this.prisma.faq.create({ data: { question: data.question, answer: data.answer, category: data.category || 'general', sortOrder: data.sortOrder || 0 } }).catch((e) => { throw e; });
  }

  async updateFaq(id: string, data: { question?: string; answer?: string; category?: string; sortOrder?: number; isActive?: boolean }) {
    return this.prisma.faq.update({ where: { id }, data }).catch((e) => { throw e; });
  }

  async deleteFaq(id: string) {
    return this.prisma.faq.delete({ where: { id } }).catch((e) => { throw e; });
  }

  // ─── Blog Posts ───────────────────────────────────────────────────────

  async listBlogs(opts: { published?: boolean; q?: string; limit?: number; offset?: number }) {
    return this.prisma.blogPost.findMany({
      where: {
        ...(opts.published !== undefined ? { isPublished: opts.published } : {}),
        ...(opts.q ? { OR: [{ title: { contains: opts.q, mode: 'insensitive' } }, { author: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
    }).catch(() => []);
  }

  async createBlog(data: { title: string; content: string; summary?: string; imageUrl?: string; author?: string; tags?: string[]; isPublished?: boolean }) {
    const slug = slugify(data.title) + '-' + Date.now();
    return this.prisma.blogPost.create({
      data: { ...data, slug, tags: data.tags || [], publishedAt: data.isPublished ? new Date() : null },
    }).catch((e) => { throw e; });
  }

  async updateBlog(id: string, data: any) {
    if (data.isPublished && !data.publishedAt) data.publishedAt = new Date();
    return this.prisma.blogPost.update({ where: { id }, data }).catch((e) => { throw e; });
  }

  async deleteBlog(id: string) {
    return this.prisma.blogPost.delete({ where: { id } }).catch((e) => { throw e; });
  }

  // ─── Taxes ────────────────────────────────────────────────────────────

  async listTaxes() {
    return this.prisma.taxConfig.findMany({ orderBy: { createdAt: 'asc' } }).catch(() => []);
  }

  async createTax(data: { name: string; type?: string; rate: number; hsnCode?: string; appliesTo?: string[] }) {
    return this.prisma.taxConfig.create({ data: { ...data, appliesTo: data.appliesTo || ['SERVICE'] } }).catch((e) => { throw e; });
  }

  async updateTax(id: string, data: { name?: string; rate?: number; isActive?: boolean; appliesTo?: string[] }) {
    return this.prisma.taxConfig.update({ where: { id }, data }).catch((e) => { throw e; });
  }

  async deleteTax(id: string) {
    return this.prisma.taxConfig.delete({ where: { id } }).catch((e) => { throw e; });
  }

  // ─── Seasonal Ads ─────────────────────────────────────────────────────

  async listAds(type?: string) {
    return this.prisma.seasonalAd.findMany({
      where: type ? { type } : {},
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    }).catch(() => []);
  }

  async createAd(data: any) {
    return this.prisma.seasonalAd.create({ data: { ...data, cityFilter: data.cityFilter || [] } }).catch((e) => { throw e; });
  }

  async updateAd(id: string, data: any) {
    return this.prisma.seasonalAd.update({ where: { id }, data }).catch((e) => { throw e; });
  }

  async deleteAd(id: string) {
    return this.prisma.seasonalAd.delete({ where: { id } }).catch((e) => { throw e; });
  }

  // ─── Staff ────────────────────────────────────────────────────────────

  async listStaff() {
    return this.prisma.staffMember.findMany({ orderBy: { joinedAt: 'desc' } }).catch(() => []);
  }

  async createStaff(data: { name: string; email: string; phone?: string; role?: string; department?: string }) {
    return this.prisma.staffMember.create({ data }).catch((e) => { throw e; });
  }

  async updateStaff(id: string, data: any) {
    return this.prisma.staffMember.update({ where: { id }, data }).catch((e) => { throw e; });
  }

  async deleteStaff(id: string) {
    return this.prisma.staffMember.delete({ where: { id } }).catch((e) => { throw e; });
  }

  // ─── Reviews management ───────────────────────────────────────────────

  async listReviews(opts: { q?: string; limit?: number }) {
    return this.prisma.review.findMany({
      where: {
        ...(opts.q ? { OR: [{ comment: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      include: {
        user: { select: { name: true, phone: true } },
        service: { select: { name: true } },
        vendor: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
    });
  }

  async deleteReview(id: string) {
    return this.prisma.review.delete({ where: { id } });
  }

  // ─── CRM Leads ───────────────────────────────────────────────────────

  async listLeads(opts: { status?: string; source?: string; q?: string; limit?: number }) {
    return this.prisma.lead.findMany({
      where: {
        ...(opts.status ? { status: opts.status as any } : {}),
        ...(opts.source ? { source: opts.source as any } : {}),
        ...(opts.q ? { OR: [
          { customerName: { contains: opts.q, mode: 'insensitive' } },
          { customerPhone: { contains: opts.q } },
          { customerEmail: { contains: opts.q, mode: 'insensitive' } },
        ]} : {}),
      },
      include: { agent: { select: { name: true, phone: true } }, activities: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
    });
  }

  async getLead(id: string) {
    return this.prisma.lead.findUnique({
      where: { id },
      include: { agent: { select: { name: true, phone: true } }, activities: { orderBy: { createdAt: 'desc' } } },
    });
  }

  async updateLeadStatus(id: string, status: string, notes?: string, lostReason?: string) {
    return this.prisma.lead.update({ where: { id }, data: { status: status as any, notes, lostReason } });
  }

  async assignLead(id: string, agentId: string) {
    return this.prisma.lead.update({ where: { id }, data: { assignedAgentId: agentId } });
  }

  async deleteLead(id: string) {
    return this.prisma.lead.delete({ where: { id } });
  }

  async crmFunnel() {
    const grouped = await this.prisma.lead.groupBy({ by: ['status'], _count: true });
    const result: Record<string, number> = {};
    grouped.forEach((g) => { result[g.status] = g._count; });
    return result;
  }

  // ─── AMC ────────────────────────────────────────────────────────────

  async listAmcPlans() {
    return this.prisma.amcPlan.findMany({ orderBy: { priceYearly: 'asc' } });
  }

  async createAmcPlan(data: any) {
    const { serviceKeys, features, ...rest } = data;
    return this.prisma.amcPlan.create({ data: { ...rest, includedServices: serviceKeys || rest.includedServices || [] } });
  }

  async updateAmcPlan(id: string, data: any) {
    const { serviceKeys, features, ...rest } = data;
    if (serviceKeys) rest.includedServices = serviceKeys;
    return this.prisma.amcPlan.update({ where: { id }, data: rest });
  }

  async deleteAmcPlan(id: string) {
    return this.prisma.amcPlan.delete({ where: { id } });
  }

  async listAmcSubscriptions(status?: string) {
    return this.prisma.amcSubscription.findMany({
      where: status ? { status: status as any } : {},
      include: { plan: { select: { name: true } }, user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ─── Invoices ────────────────────────────────────────────────────────

  async listInvoices(opts: { q?: string; limit?: number }) {
    return this.prisma.invoice.findMany({
      where: opts.q ? { invoiceNumber: { contains: opts.q, mode: 'insensitive' } } : {},
      include: {
        order: {
          include: { customer: { select: { name: true, phone: true } } },
        },
      },
      orderBy: { generatedAt: 'desc' },
      take: opts.limit || 100,
    });
  }

  async getInvoice(id: string) {
    return this.prisma.invoice.findUnique({
      where: { id },
      include: { order: { include: { customer: true, items: { include: { product: true } } } } },
    });
  }

  // Was previously a third, undocumented copy of the GST math (didn't call
  // computeInvoiceBreakdown at all) — the one actually wired to the admin "Generate
  // Invoice" button. Now routes through the same billing engine as every other
  // invoice-generation path (see InvoicesService.generateForOrder).
  //
  // Also the manual retry path for OrdersService.autoGenerateInvoice()'s own fire-and-forget
  // failures (invoiceGenerationFailed/invoiceGenerationError on Order) — generateForOrder()
  // is idempotent (returns the existing Invoice if one already exists), so re-running this
  // after a fix (e.g. missing SiteSetting/GST config) can never create a duplicate invoice.
  async generateInvoice(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    try {
      const invoice = await this.invoices.generateForOrder(orderId);
      await this.prisma.order.update({
        where: { id: orderId },
        data: { invoiceGenerationFailed: false, invoiceGenerationError: null },
      });
      return invoice;
    } catch (e) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { invoiceGenerationFailed: true, invoiceGenerationError: String(e.message || e).slice(0, 1000) },
      }).catch(() => {});
      throw e;
    }
  }

  // ─── Corporate ────────────────────────────────────────────────────────

  async listCorporate() {
    return this.prisma.corporateAccount.findMany({
      include: { members: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCorporate(id: string) {
    return this.prisma.corporateAccount.findUnique({ where: { id }, include: { members: { include: { user: { select: { name: true, phone: true, email: true } } } } } });
  }

  async updateCorporate(id: string, data: any) {
    return this.prisma.corporateAccount.update({ where: { id }, data });
  }

  // ─── Wallet Transactions ──────────────────────────────────────────────

  async listWalletTransactions(opts: { userId?: string; type?: string; reason?: string; limit?: number }) {
    return this.prisma.walletTransaction.findMany({
      where: {
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(opts.type ? { type: opts.type as any } : {}),
        ...(opts.reason ? { reason: opts.reason as any } : {}),
      },
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
    });
  }

  // ─── Vendor Earnings & Payouts (frontend/admin/partner-earnings.html) ─
  // Previously called /admin/vendor-earnings and /admin/vendor-payouts, neither of which
  // existed anywhere in the backend — every action on that admin screen 404'd. Payout
  // recording itself is delegated to SettlementsService (Phase 1), the single source of
  // truth for manual partner settlement record-keeping.
  async vendorEarningsSummary(q?: string, payoutStatus?: string) {
    const vendors = await this.prisma.serviceVendor.findMany({
      where: {
        ...(q ? { fullName: { contains: q, mode: 'insensitive' as const } } : {}),
        ...(payoutStatus === 'PENDING' ? { pendingPayout: { gt: 0 } } : {}),
        ...(payoutStatus === 'PAID' ? { pendingPayout: 0 } : {}),
      },
      select: {
        id: true, fullName: true, baseCity: true, totalEarnings: true,
        pendingPayout: true, completedJobs: true, rating: true,
      },
      orderBy: { pendingPayout: 'desc' },
    });
    const vendorIds = vendors.map((v) => v.id);
    const commissionAgg = vendorIds.length
      ? await this.prisma.order.groupBy({
          by: ['vendorId'],
          where: { vendorId: { in: vendorIds }, status: { in: ['COMPLETED', 'INVOICED', 'CLOSED'] as any[] } },
          _sum: { remontCommission: true },
        })
      : [];
    const commissionByVendor = new Map(commissionAgg.map((c) => [c.vendorId, Number(c._sum.remontCommission || 0)]));

    return vendors.map((v) => ({
      vendorId: v.id,
      vendorName: v.fullName,
      city: v.baseCity,
      // Decimal fields serialize to JSON strings (decimal.js's toJSON = toString()) — must be
      // Number()-converted here, same as totalPaid/commission below, or client-side summing
      // (partner-earnings.html's summary cards) silently does string concatenation → NaN.
      totalEarnings: Number(v.totalEarnings),
      pendingPayout: Number(v.pendingPayout),
      totalPaid: Number(v.totalEarnings) - Number(v.pendingPayout),
      commission: commissionByVendor.get(v.id) || 0,
      jobsCompleted: v.completedJobs,
      rating: v.rating,
    }));
  }

  async vendorPayout(adminId: string, vendorId: string, amount: number, mode: SettlementMode, referenceNumber?: string, notes?: string) {
    return this.settlements.record(vendorId, amount, mode, adminId, referenceNumber, notes);
  }

  async exportWalletTransactions() {
    return this.prisma.walletTransaction.findMany({
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
  }

  // ─── Servicemen Enquiries ─────────────────────────────────────────────

  async listServicemenEnquiries() {
    // Was filtering on 'PENDING'/'UNDER_REVIEW' — neither is a valid VendorStatus value
    // (the enum is PENDING_VERIFICATION/ACTIVE/SUSPENDED/REJECTED), so this always
    // silently returned zero rows regardless of how many vendors were actually pending.
    return this.prisma.serviceVendor.findMany({
      where: { status: VendorStatus.PENDING_VERIFICATION },
      include: {
        user: { select: { name: true, phone: true, email: true, createdAt: true } },
        documents: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─── Coupons management ───────────────────────────────────────────────

  async listCoupons() {
    return this.prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createCoupon(data: any) {
    return this.prisma.coupon.create({ data });
  }

  async updateCoupon(id: string, data: any) {
    return this.prisma.coupon.update({ where: { id }, data });
  }

  async deleteCoupon(id: string) {
    return this.prisma.coupon.delete({ where: { id } });
  }

  // ─── Membership plans ─────────────────────────────────────────────────

  async listMembershipPlans() {
    return this.prisma.membershipPlan.findMany({ orderBy: { priceMonthly: 'asc' } });
  }

  async createMembershipPlan(data: any) {
    return this.prisma.membershipPlan.create({ data });
  }

  async updateMembershipPlan(id: string, data: any) {
    return this.prisma.membershipPlan.update({ where: { id }, data });
  }

  // ─── Customers (CRM) ──────────────────────────────────────────────────
  async listCustomers(opts: { q?: string; limit?: number; offset?: number; cityId?: string }) {
    const where: any = { role: 'CUSTOMER' };
    if (opts.q) {
      where.OR = [
        { name: { contains: opts.q, mode: 'insensitive' } },
        { phone: { contains: opts.q } },
        { email: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.cityId) where.cityId = opts.cityId;
    const [customers, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true, name: true, phone: true, email: true, createdAt: true,
          isBlocked: true, walletBalance: true, cityId: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: opts.limit || 100,
        skip: opts.offset || 0,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { customers, total };
  }

  async getCustomer(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, orderNumber: true, status: true, totalAmount: true, createdAt: true },
        },
        addresses: true,
        walletTransactions: { orderBy: { createdAt: 'desc' }, take: 5 },
        _count: { select: { orders: true } },
      },
    });
  }

  // ─── Reports ──────────────────────────────────────────────────────────
  async salesReport(opts: { from?: string; to?: string }) {
    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 30 * 86400000);
    const to = opts.to ? new Date(opts.to) : new Date();
    // "Top selling" must not count line items from orders that never actually resulted in a
    // sale — a CANCELLED/REFUNDED order's items would otherwise inflate these rankings.
    const sellableOrder = { status: { notIn: ['CANCELLED', 'REFUNDED'] as any[] } };
    const [orders, revenue, byStatus, topProductsRaw, topServicesRaw, byChannel, avgValue] = await Promise.all([
      this.prisma.order.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: from, lte: to }, paymentStatus: 'PAID' },
        _sum: { totalAmount: true, remontCommission: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { createdAt: { gte: from, lte: to } },
        _count: true,
        _sum: { totalAmount: true },
      }),
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { createdAt: { gte: from, lte: to }, ...sellableOrder } },
        _count: { id: true },
        _sum: { totalPrice: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.prisma.orderServiceItem.groupBy({
        by: ['serviceId'],
        where: { order: { createdAt: { gte: from, lte: to }, ...sellableOrder } },
        _count: { id: true },
        _sum: { totalPrice: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.prisma.order.groupBy({ by: ['channel'], where: { createdAt: { gte: from, lte: to } }, _count: true }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: from, lte: to }, paymentStatus: 'PAID' },
        _avg: { totalAmount: true },
      }),
    ]);

    const [productNames, serviceNames] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: topProductsRaw.map((p) => p.productId) } }, select: { id: true, name: true } }),
      this.prisma.service.findMany({ where: { id: { in: topServicesRaw.map((s) => s.serviceId) } }, select: { id: true, name: true } }),
    ]);
    const productNameById = new Map(productNames.map((p) => [p.id, p.name]));
    const serviceNameById = new Map(serviceNames.map((s) => [s.id, s.name]));

    const topProducts = topProductsRaw.map((p) => ({
      productId: p.productId,
      name: productNameById.get(p.productId) || 'Unknown product',
      count: p._count?.id || 0,
      revenue: Number(p._sum?.totalPrice || 0),
    }));
    const topServices = topServicesRaw.map((s) => ({
      serviceId: s.serviceId,
      name: serviceNameById.get(s.serviceId) || 'Unknown service',
      count: s._count?.id || 0,
      revenue: Number(s._sum?.totalPrice || 0),
    }));

    return {
      period: { from, to },
      summary: {
        totalOrders: orders,
        totalRevenue: Number(revenue._sum.totalAmount || 0),
        platformCommission: Number(revenue._sum.remontCommission || 0),
        avgOrderValue: Number(avgValue._avg.totalAmount || 0),
      },
      byStatus,
      topProducts,
      topServices,
      byChannel,
    };
  }

  async ordersReport(opts: { from?: string; to?: string; status?: string }) {
    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 30 * 86400000);
    const to = opts.to ? new Date(opts.to) : new Date();
    const where: any = { createdAt: { gte: from, lte: to } };
    if (opts.status) where.status = opts.status;
    const [orders, byStatus, byChannel, avgValue] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: {
          id: true, orderNumber: true, status: true, totalAmount: true,
          paymentStatus: true, channel: true, createdAt: true,
          customer: { select: { name: true, phone: true } },
          vendor: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.order.groupBy({ by: ['status'], where, _count: true, _sum: { totalAmount: true } }),
      this.prisma.order.groupBy({ by: ['channel'], where, _count: true }),
      this.prisma.order.aggregate({ where: { ...where, paymentStatus: 'PAID' }, _avg: { totalAmount: true } }),
    ]);
    return {
      period: { from, to },
      orders,
      byStatus,
      byChannel,
      avgOrderValue: Number(avgValue._avg.totalAmount || 0),
    };
  }

  async vendorReport() {
    const [topVendors, pendingApprovals, byCity] = await Promise.all([
      this.prisma.serviceVendor.findMany({
        where: { status: 'ACTIVE' as any },
        select: {
          id: true, fullName: true, rating: true, totalEarnings: true, completedJobs: true,
          skills: true, baseCity: true, user: { select: { phone: true } },
        },
        orderBy: { completedJobs: 'desc' },
        take: 50,
      }),
      this.prisma.serviceVendor.count({ where: { status: { in: ['PENDING', 'PENDING_VERIFICATION'] as any } } }),
      this.prisma.serviceVendor.groupBy({ by: ['baseCity'], _count: true }),
    ]);
    return { topVendors, pendingApprovals, byCity };
  }

  async financialReport(opts: { from?: string; to?: string }) {
    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 30 * 86400000);
    const to = opts.to ? new Date(opts.to) : new Date();
    const [revenue, byGateway, recentTx, refunds, walletCredits] = await Promise.all([
      this.prisma.order.aggregate({
        where: { createdAt: { gte: from, lte: to }, paymentStatus: 'PAID' },
        _sum: { totalAmount: true, gstAmount: true, remontCommission: true },
        _count: true,
      }),
      this.prisma.paymentTransaction.groupBy({
        by: ['gateway'],
        where: { createdAt: { gte: from, lte: to }, status: 'PAID' },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.paymentTransaction.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { gateway: true, status: true, amount: true, createdAt: true, gatewayOrderId: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.order.count({ where: { createdAt: { gte: from, lte: to }, paymentStatus: 'REFUNDED' } }),
      this.prisma.walletTransaction.aggregate({
        where: { createdAt: { gte: from, lte: to }, type: 'CREDIT' },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    return {
      period: { from, to },
      revenue: {
        gross: Number(revenue._sum.totalAmount || 0),
        gst: Number(revenue._sum.gstAmount || 0),
        commission: Number(revenue._sum.remontCommission || 0),
        paidOrders: revenue._count,
      },
      byGateway,
      recentTransactions: recentTx,
      refunds,
      walletCredits: { total: Number(walletCredits._sum.amount || 0), count: walletCredits._count },
    };
  }

  // ─── Payment Dashboard (Section 9: complete payment management) ───────
  // Everything here is computed live from PaymentTransaction/Order/RefundRequest/
  // PartnerSettlement — no separately-maintained ledger table, so there's nothing to keep
  // in sync and no manual calculation anywhere in the numbers below.
  private bucketKey(date: Date, bucket: 'day' | 'week' | 'month'): string {
    const d = new Date(date);
    if (bucket === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (bucket === 'week') {
      const oneJan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return d.toISOString().slice(0, 10);
  }

  async paymentDashboard(opts: { from?: string; to?: string; bucket?: 'day' | 'week' | 'month' }) {
    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 30 * 86400000);
    const to = opts.to ? new Date(opts.to) : new Date();
    const bucket = opts.bucket || 'day';

    const [totalCollection, pendingCollection, failedPayments, refundsAgg, settlementsAgg, codVsOnline, ordersInRange] = await Promise.all([
      this.prisma.paymentTransaction.aggregate({ where: { createdAt: { gte: from, lte: to }, status: 'PAID' }, _sum: { amount: true }, _count: true }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: from, lte: to }, paymentStatus: { in: ['PENDING', 'PARTIAL'] as any[] } }, _sum: { totalAmount: true, walletUsed: true }, _count: true }),
      this.prisma.paymentTransaction.aggregate({ where: { createdAt: { gte: from, lte: to }, status: 'FAILED' }, _sum: { amount: true }, _count: true }),
      this.prisma.refundRequest.aggregate({ where: { createdAt: { gte: from, lte: to }, status: { in: ['APPROVED', 'PARTIALLY_APPROVED', 'PROCESSED'] as any[] } }, _sum: { approvedAmount: true }, _count: true }),
      this.prisma.partnerSettlement.aggregate({ where: { paidAt: { gte: from, lte: to } }, _sum: { amount: true }, _count: true }),
      this.prisma.order.groupBy({ by: ['paymentMethod'], where: { createdAt: { gte: from, lte: to } }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.order.findMany({ where: { createdAt: { gte: from, lte: to }, paymentStatus: 'PAID' }, select: { totalAmount: true, createdAt: true } }),
    ]);

    const outstandingAmount = Math.max(0, Number(pendingCollection._sum.totalAmount || 0) - Number(pendingCollection._sum.walletUsed || 0));

    const trendMap = new Map<string, number>();
    for (const o of ordersInRange) {
      const key = this.bucketKey(o.createdAt, bucket);
      trendMap.set(key, (trendMap.get(key) || 0) + Number(o.totalAmount));
    }
    const trend = [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, amount]) => ({ period, amount }));

    return {
      period: { from, to, bucket },
      totalCollection: { amount: Number(totalCollection._sum.amount || 0), count: totalCollection._count },
      pendingCollection: { count: pendingCollection._count },
      failedPayments: { amount: Number(failedPayments._sum.amount || 0), count: failedPayments._count },
      refunds: { amount: Number(refundsAgg._sum.approvedAmount || 0), count: refundsAgg._count },
      partnerSettlements: { amount: Number(settlementsAgg._sum.amount || 0), count: settlementsAgg._count },
      codVsOnline: codVsOnline.map((g) => ({ paymentMethod: g.paymentMethod, amount: Number(g._sum.totalAmount || 0), count: g._count })),
      outstandingAmount,
      trend,
    };
  }

  /** Full financial trail for one order/booking — every PaymentTransaction and RefundRequest against it. */
  async getOrderLedger(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const [transactions, refundRequests] = await Promise.all([
      this.prisma.paymentTransaction.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.refundRequest.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const paidAmount = transactions.filter((t) => t.status === 'PAID').reduce((s, t) => s + Number(t.amount), 0);
    const balanceDue = Math.max(0, Number(order.totalAmount) - paidAmount - Number(order.walletUsed));
    return {
      order,
      transactions,
      refundRequests,
      summary: { totalAmount: order.totalAmount, walletUsed: order.walletUsed, paidAmount, balanceDue },
    };
  }

  /** Full financial trail for one partner — settlements paid, and the completed jobs behind their earnings. */
  async getPartnerLedger(vendorId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    const [settlements, completedOrders] = await Promise.all([
      this.prisma.partnerSettlement.findMany({ where: { vendorId }, orderBy: { paidAt: 'desc' } }),
      this.prisma.order.findMany({
        where: { vendorId, status: { in: ['COMPLETED', 'INVOICED', 'CLOSED'] as any[] } },
        select: { id: true, orderNumber: true, totalAmount: true, vendorPayout: true, remontCommission: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 100,
      }),
    ]);
    return {
      vendor: { id: vendor.id, fullName: vendor.fullName, totalEarnings: Number(vendor.totalEarnings), pendingPayout: Number(vendor.pendingPayout) },
      settlements,
      completedOrders,
    };
  }

  // ─── Payment Transactions ─────────────────────────────────────────────
  async listPaymentTransactions(opts: { status?: string; gateway?: string; limit?: number; offset?: number }) {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.gateway) where.gateway = opts.gateway;
    const [transactions, total] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: opts.limit || 100,
        skip: opts.offset || 0,
      }),
      this.prisma.paymentTransaction.count({ where }),
    ]);
    // PaymentTransaction.orderId is a loose, non-FK string (see schema comment) — no Prisma
    // relation to join through, so resolve orderNumber with one extra batched lookup instead
    // of leaving the frontend to guess at a `.order` relation that never existed.
    const orderIds = [...new Set(transactions.map((t) => t.orderId).filter(Boolean))] as string[];
    const orders = orderIds.length
      ? await this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } })
      : [];
    const orderNumberById = new Map(orders.map((o) => [o.id, o.orderNumber]));
    const enriched = transactions.map((t) => ({
      ...t,
      orderNumber: t.isWalletTopup ? 'Wallet Top-up' : (t.orderId ? orderNumberById.get(t.orderId) || null : null),
    }));
    return { transactions: enriched, total };
  }

  async markPaymentFailed(id: string, reason?: string) {
    const tx = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Payment transaction not found');
    if (tx.status === 'PAID') throw new BadRequestException('Cannot mark a completed payment as failed');
    return this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'FAILED', failureReason: reason || 'Manually marked failed by admin' },
    });
  }

  // ─── Integrations Config ──────────────────────────────────────────────
  async getIntegrations() {
    const settings = await this.prisma.siteSetting.findMany({
      where: { group: { in: ['payment', 'whatsapp', 'sms', 'email', 'ai'] } },
    });
    const grouped: Record<string, any> = {};
    for (const s of settings) {
      if (!grouped[s.group]) grouped[s.group] = {};
      grouped[s.group][s.key] = s.value;
    }
    return grouped;
  }

  async updateIntegration(group: string, data: Record<string, string>) {
    const ops = Object.entries(data).map(([key, value]) =>
      this.prisma.siteSetting.upsert({
        where: { key },
        create: { key, value, label: key.replace(/_/g, ' '), group },
        update: { value },
      }),
    );
    await Promise.all(ops);
    // Live-reload payment gateway when credentials change — no server restart needed
    if (group === 'payment') await this.payments.reinitialize();
    return { success: true };
  }

  // ─── Review approve ───────────────────────────────────────────────────
  async approveReview(id: string) {
    return this.prisma.review.update({ where: { id }, data: { isApproved: true } as any }).catch(() => null);
  }
}

// ─── Controller ─────────────────────────────────────────────────────────────

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService, private masterOrders: MasterOrdersService, private invoices: InvoicesService) {}

  // Dashboard
  @Get('stats') stats() { return this.admin.globalStats(); }
  @Get('analytics') analytics(@Query('days') days?: number) { return this.admin.getAnalytics(days ? +days : 30); }

  // Master Orders (Phase 2 scaffold — flat child-order list per master today;
  // the split-engine + admin tree view land in a later phase)
  @Get('master-orders') masterOrdersList(@Query('status') status?: string, @Query('q') q?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.masterOrders.adminList({ status, q, limit: limit ? +limit : undefined, offset: offset ? +offset : undefined });
  }
  @Get('master-orders/:id') masterOrderDetail(@Param('id') id: string) { return this.masterOrders.adminGetById(id); }

  // Seed
  @Post('seed') seed() { return this.admin.seedData(); }

  // Users
  @Get('users') users(@Query('role') role?: UserRole, @Query('q') q?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.admin.listUsers({ role, q, limit, offset });
  }
  @Patch('users/:id/block') block(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { block: boolean }) { return this.admin.blockUser(id, b.block, u.sub, u.role); }
  @Patch('users/:id/wallet') wallet(@Param('id') id: string, @Body() b: { amount: number; notes: string }) { return this.admin.adjustWallet(id, b.amount, b.notes); }
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('users/:id/role') setRole(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { role: UserRole }) {
    return this.admin.setUserRole(u.sub, u.role, id, b.role);
  }

  // Audit
  @Roles(UserRole.SUPER_ADMIN)
  @Get('audit-logs') auditLogs(@Query('action') action?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.admin.listAuditLogs({ action, limit: limit ? +limit : undefined, offset: offset ? +offset : undefined });
  }

  // Vendors
  @Get('vendors/pending') pending() { return this.admin.pendingVendorApprovals(); }
  @Get('vendors') allVendors(
    @Query('status') status?: VendorStatus, @Query('q') q?: string, @Query('limit') limit?: number,
    @Query('agencyOwner') agencyOwner?: string, @Query('agencyOwnerId') agencyOwnerId?: string,
  ) {
    return this.admin.allVendors({ status, q, limit, agencyOwner: agencyOwner === 'true', agencyOwnerId });
  }
  @Patch('vendors/:id/approve') approve(@Param('id') id: string) { return this.admin.approveVendor(id); }
  @Patch('vendors/:id/reject') reject(@Param('id') id: string, @Body() b: { reason: string }) { return this.admin.rejectVendor(id, b.reason); }
  @Patch('vendors/:id/suspend') suspend(@Param('id') id: string) { return this.admin.suspendVendor(id); }
  @Patch('vendors/:id/staff-type') setStaffType(@Param('id') id: string, @Body() b: { staffType: 'IN_HOUSE' | 'PARTNER' }) {
    return this.admin.setVendorStaffType(id, b.staffType);
  }
  @Patch('vendors/:id/base-hold') setBaseHold(@Param('id') id: string, @Body() b: { amount: number }) {
    return this.admin.setVendorBaseHold(id, b.amount);
  }
  @Get('vendors/:id/holds') vendorHolds(@Param('id') id: string) { return this.admin.vendorHolds(id); }
  @Post('vendors/:id/hold') createHold(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { amount: number; notes?: string }) {
    return this.admin.createAdminHold(id, b.amount, u.sub, b.notes);
  }
  @Post('vendors/:id/ledger-adjustment') postLedgerAdjustment(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { amount: number; reason: string }) {
    return this.admin.postLedgerAdjustment(id, b.amount, b.reason, u.sub);
  }
  @Post('holds/:id/release') releaseHold(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.releaseHold(id, u.sub); }
  @Post('holds/:id/forfeit') forfeitHold(@Param('id') id: string, @Body() b: { reason?: string }) { return this.admin.forfeitHold(id, b.reason); }
  @Patch('holds/:id/extend') extendHold(@Param('id') id: string, @Body() b: { releaseDueAt: string }) { return this.admin.extendHold(id, b.releaseDueAt); }
  @Roles(UserRole.SUPER_ADMIN)
  @Delete('vendors/:id') deleteVendorDirect(@Param('id') id: string) { return this.admin.deleteServiceVendorDirect(id); }

  // ─── Vendor documents — verify/reject/download (download is just the existing url) ───
  @Patch('vendors/documents/:docId/verify') verifyDoc(@Param('docId') id: string) { return this.admin.verifyVendorDocument(id); }
  @Patch('vendors/documents/:docId/reject') rejectDoc(@Param('docId') id: string) { return this.admin.rejectVendorDocument(id); }

  // ─── Vendor address/city correction requests ───────────────────────────────────────
  @Get('vendors/city-update-requests') cityUpdateRequests(@Query('status') status?: string) { return this.admin.listCityUpdateRequests(status); }
  @Patch('vendors/city-update-requests/:id/approve') approveCityUpdate(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.admin.approveCityUpdate(id, u.sub);
  }
  @Patch('vendors/city-update-requests/:id/reject') rejectCityUpdate(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.admin.rejectCityUpdate(id, u.sub);
  }

  // ─── Phase 2: Agency Partner Management ────────────────────────────
  @Patch('agencies/:id/approve') approveAgency(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.approveAgency(id, u.sub); }
  @Patch('agencies/:id/suspend') suspendAgency(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.suspendAgency(id, u.sub); }
  @Patch('agencies/members/:id/freeze') freezeMember(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.freezeMember(id, u.sub); }
  @Patch('agencies/members/:id/unfreeze') unfreezeMember(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.admin.unfreezeMember(id, u.sub); }
  @Patch('agencies/members/:id/transfer') transferMember(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { newAgencyOwnerId: string }) {
    return this.admin.transferMember(id, b.newAgencyOwnerId, u.sub);
  }
  @Get('vendors/attendance') vendorAttendance(@Query('date') date?: string, @Query('agencyOwnerId') agencyOwnerId?: string) {
    return this.admin.vendorAttendance(date, agencyOwnerId);
  }
  // Declared last among GET vendors/* routes deliberately — Nest/Express matches routes
  // in declaration order, so a `:id` wildcard placed before a static path like
  // vendors/city-update-requests would swallow it (id="city-update-requests") instead of
  // ever reaching that handler. Every more-specific GET vendors/... route above this one
  // must stay above it; any new static GET route must also be added above, not below.
  @Get('vendors/:id') vendorDetail(@Param('id') id: string) { return this.admin.getVendorDetail(id); }
  // 3+ segments — never shadowed by the vendors/:id wildcard above (Nest/Express route
  // matching is also segment-count-sensitive), safe to declare in either order.
  @Get('vendors/:id/ledger/export') vendorLedgerExport(@Param('id') id: string) { return this.admin.vendorLedgerForExport(id); }
  @Patch('withdrawals/:id/approve') approveWithdrawal(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { note?: string }) {
    return this.admin.approveWithdrawal(id, u.sub, b?.note);
  }
  @Patch('withdrawals/:id/reject') rejectWithdrawal(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { note?: string }) {
    return this.admin.rejectWithdrawal(id, u.sub, b?.note);
  }

  @Get('product-vendors') listProductVendors(@Query('status') status?: VendorStatus, @Query('q') q?: string, @Query('limit') limit?: number) {
    return this.admin.listProductVendors({ status, q, limit });
  }
  @Post('product-vendors') createProductVendor(@Body() b: CreateProductVendorDto) {
    return this.admin.createProductVendor(b);
  }
  @Patch('product-vendors/:id') updateProductVendor(@Param('id') id: string, @Body() b: UpdateProductVendorDto) {
    return this.admin.updateProductVendor(id, b);
  }
  @Patch('product-vendors/:id/suspend') suspendProductVendor(@Param('id') id: string) { return this.admin.suspendProductVendor(id); }
  @Patch('product-vendors/:id/activate') activateProductVendor(@Param('id') id: string) { return this.admin.activateProductVendor(id); }
  @Roles(UserRole.SUPER_ADMIN)
  @Delete('product-vendors/:id') deleteProductVendorDirect(@Param('id') id: string) { return this.admin.deleteProductVendorDirect(id); }

  // Delete Requests — regular admins request, only SUPER_ADMIN approves/rejects/lists
  @Post('delete-requests')
  createDeleteRequest(@CurrentUser() u: JwtPayload, @Body() b: { targetType: DeleteTargetType; targetId: string; reason?: string }) {
    return this.admin.createDeleteRequest(u.sub, b.targetType, b.targetId, b.reason);
  }
  @Roles(UserRole.SUPER_ADMIN)
  @Get('delete-requests')
  listDeleteRequests(@Query('status') status?: string) { return this.admin.listDeleteRequests(status); }
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('delete-requests/:id/approve')
  approveDeleteRequest(@Param('id') id: string, @CurrentUser() u: JwtPayload, @Body() b: { reviewNote?: string }) {
    return this.admin.approveDeleteRequest(id, u.sub, b?.reviewNote);
  }
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('delete-requests/:id/reject')
  rejectDeleteRequest(@Param('id') id: string, @CurrentUser() u: JwtPayload, @Body() b: { reviewNote?: string }) {
    return this.admin.rejectDeleteRequest(id, u.sub, b?.reviewNote);
  }

  // Orders
  // Orders — stats + list + management
  @Get('orders/stats') orderStats() { return this.admin.orderStats(); }
  @Get('orders/vendors') orderVendors(@Query('skill') skill?: string, @Query('orderId') orderId?: string) { return this.admin.listActiveVendors(skill, orderId); }
  @Get('orders') listOrders(
    @Query('status') status?: string, @Query('city') city?: string, @Query('q') q?: string,
    @Query('channel') channel?: string, @Query('limit') limit?: number, @Query('offset') offset?: number,
    @Query('stuck') stuck?: string, @Query('invoiceFailed') invoiceFailed?: string,
  ) { return this.admin.listOrders({ status, city, q, channel, limit, offset, stuck: stuck === 'true', invoiceFailed: invoiceFailed === 'true' }); }
  @Post('orders') adminCreateOrder(@Body() b: any) { return this.admin.adminCreateOrder(b); }
  @Get('orders/:id') adminGetOrder(@Param('id') id: string) { return this.admin.adminGetOrder(id); }
  @Patch('orders/:id/status') updateOrderStatus(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { status: string; note?: string }) { return this.admin.adminUpdateStatus(id, b.status, b.note, u.sub, u.role); }
  @Patch('orders/:id/note') updateOrderNote(@Param('id') id: string, @Body() b: { note: string }) { return this.admin.adminUpdateNote(id, b.note); }
  @Patch('orders/:id/assign-vendor') assignVendor(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { vendorId: string }) { return this.admin.forceAssignVendor(id, b.vendorId, u.sub, u.role); }
  @Patch('orders/:id/cancel') cancelOrder(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { reason: string }) { return this.admin.adminCancelOrder(id, b.reason, u.sub, u.role); }
  @Patch('orders/:id/refund') refund(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { reason: string }) { return this.admin.refundOrder(id, b.reason, u.sub, u.role); }
  @Delete('orders/all') deleteAllOrders() { return this.admin.deleteAllOrders(); }

  // Cities
  @Get('cities') cities() { return this.admin.listCities(); }
  @Get('cities/stats') citiesStats() { return this.admin.cityStats(); }
  @Post('cities') createCity(@Body() b: any) { return this.admin.createCity(b); }
  // 'bulk' and 'all' must come before ':name' — same path depth, would otherwise be
  // swallowed as a city name (same gotcha as the :slug routes elsewhere in this codebase).
  @Patch('cities/bulk') bulkToggleCities(@Body() b: { cityNames: string[]; isActive: boolean }) {
    return this.admin.bulkToggleCities(b.cityNames, b.isActive);
  }
  @Patch('cities/all') toggleAllCities(@Body() b: { isActive: boolean }) { return this.admin.toggleAllCities(b.isActive); }
  @Patch('cities/:name') updateCity(@Param('name') name: string, @Body() b: any) { return this.admin.updateCity(name, b); }
  @Patch('cities/:name/toggle') toggleCity(@Param('name') name: string, @Body() b: { isActive: boolean }) { return this.admin.toggleCityActive(name, b.isActive); }

  // Service Categories
  @Get('services/categories') allCategories() { return this.admin.listAllCategories(); }
  @Post('services/categories') createCategory(@Body() b: any) { return this.admin.createCategory(b); }
  @Patch('services/categories/bulk') bulkCategories(@Body() b: { ids: string[]; isActive: boolean }) { return this.admin.bulkUpdateCategories(b.ids, { isActive: b.isActive }); }
  @Patch('services/categories/:id') updateCategory(@Param('id') id: string, @Body() b: any) { return this.admin.updateCategory(id, b); }
  @Delete('services/categories/:id') deleteCategory(@Param('id') id: string) { return this.admin.deleteCategory(id); }
  @Delete('services/categories/:id/force') forceDeleteCategory(@Param('id') id: string) { return this.admin.forceDeleteCategory(id); }

  // Sub-Categories
  @Get('services/subcategories') allSubCategories(@Query('categoryId') categoryId?: string) { return this.admin.listSubCategories(categoryId); }
  @Post('services/subcategories') createSubCategory(@Body() b: any) { return this.admin.createSubCategory(b); }
  @Patch('services/subcategories/bulk') bulkSubCategories(@Body() b: { ids: string[]; isActive: boolean }) { return this.admin.bulkUpdateSubCategories(b.ids, { isActive: b.isActive }); }
  @Patch('services/subcategories/:id') updateSubCategory(@Param('id') id: string, @Body() b: any) { return this.admin.updateSubCategory(id, b); }
  @Delete('services/subcategories/:id') deleteSubCategory(@Param('id') id: string) { return this.admin.deleteSubCategory(id); }

  // Services
  @Get('services/export') exportSvcs() { return this.admin.exportServices(); }
  @Get('services') allServices(@Query('categoryId') catId?: string, @Query('q') q?: string, @Query('isActive') ia?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    const isActive = ia === 'true' ? true : ia === 'false' ? false : undefined;
    return this.admin.listAllServices({ categoryId: catId, q, isActive, limit: limit ? +limit : 200, offset: offset ? +offset : 0 });
  }
  @Post('services') createService(@Body() b: any) { return this.admin.createService(b); }
  @Post('services/bulk') bulkServices(@Body() b: { ids: string[]; isActive: boolean }) { return this.admin.bulkUpdateServices(b.ids, { isActive: b.isActive }); }
  @Patch('services/:id') updateService(@Param('id') id: string, @Body() b: any) { return this.admin.updateService(id, b); }
  @Roles(UserRole.SUPER_ADMIN)
  @Delete('services/all') deleteAllServices() { return this.admin.deleteAllServices(); }
  @Roles(UserRole.SUPER_ADMIN)
  @Delete('services/:id') deleteService(@Param('id') id: string) { return this.admin.deleteService(id); }
  @Patch('services/:id/suspend') suspendService(@Param('id') id: string) { return this.admin.suspendService(id); }
  @Get('services/:id/cities') serviceCities(@Param('id') id: string) { return this.admin.listServiceCities(id); }
  @Patch('services/:id/cities/:cityId') upsertServiceCity(@Param('id') sid: string, @Param('cityId') cid: string, @Body() b: { isActive: boolean; customPrice?: number }) {
    return this.admin.upsertServiceCity(sid, cid, b);
  }

  // Service Pricing — per-service/city/tier price sheet (STANDARD tier feeds real
  // checkout pricing, see CitiesService.getServicePrice). Inherits this controller's
  // class-level @UseGuards(JwtAuthGuard, RolesGuard) + @Roles(ADMIN, SUPER_ADMIN) —
  // same authorization already required for every other admin catalog/pricing route.
  @Get('service-pricing') listServicePricing(@Query('q') q?: string) { return this.admin.listServicePricing(q); }
  @Post('service-pricing') createServicePricing(@Body() b: any) { return this.admin.createServicePricing(b); }
  @Patch('service-pricing/:id') updateServicePricing(@Param('id') id: string, @Body() b: any) { return this.admin.updateServicePricing(id, b); }
  @Delete('service-pricing/:id') deleteServicePricing(@Param('id') id: string) { return this.admin.deleteServicePricing(id); }

  // Product Categories
  @Get('product-categories') listProductCats() { return this.admin.listProductCategories(); }
  @Post('product-categories') createProductCat(@Body() b: any) { return this.admin.createProductCategory(b); }
  @Patch('product-categories/:id') updateProductCat(@Param('id') id: string, @Body() b: any) { return this.admin.updateProductCategory(id, b); }
  @Delete('product-categories/:id') deleteProductCat(@Param('id') id: string) { return this.admin.deleteProductCategory(id); }

  // Products
  @Get('products/export') exportProds() { return this.admin.exportProducts(); }
  @Get('products') allProducts(@Query('q') q?: string, @Query('categoryId') catId?: string, @Query('isActive') ia?: string, @Query('lowStock') lowStock?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    const isActive = ia === 'true' ? true : ia === 'false' ? false : undefined;
    return this.admin.adminListProducts({ q, categoryId: catId, isActive, lowStock: lowStock === 'true', limit: limit ? +limit : 100, offset: offset ? +offset : 0 });
  }
  @Post('products') createProduct(@Body() b: any) { return this.admin.adminCreateProduct(b); }
  @Post('products/bulk') bulkProducts(@Body() b: { ids: string[]; isActive: boolean }) { return this.admin.bulkUpdateProducts(b.ids, { isActive: b.isActive }); }
  @Patch('products/:id') updateProduct(@Param('id') id: string, @Body() b: any) { return this.admin.adminUpdateProduct(id, b); }
  @Delete('products/:id') deleteProduct(@Param('id') id: string) { return this.admin.adminDeleteProduct(id); }
  @Get('products/:id/cities') productCities(@Param('id') id: string) { return this.admin.listProductCities(id); }
  @Patch('products/:id/cities/:cityId') upsertProductCity(@Param('id') pid: string, @Param('cityId') cid: string, @Body() b: { isActive: boolean; customPrice?: number; stock?: number }) {
    return this.admin.upsertProductCity(pid, cid, b);
  }

  // AI Content Generation
  @Post('ai/generate') aiGenerate(@Body() b: { type: 'SERVICE' | 'PRODUCT' | 'CATEGORY'; name: string; context?: string }) {
    return this.admin.generateAiContent(b.type, b.name, b.context);
  }
  @Post('ai/bulk-generate') aiBulkGenerate(@Body() b: { limit?: number }) {
    return this.admin.bulkGenerateAiContent(b.limit);
  }

  // Banners (CMS)
  @Get('banners') listBanners() { return this.admin.listBanners(); }
  @Post('banners') createBanner(@Body() b: any) { return this.admin.createBanner(b); }
  @Patch('banners/:id') updateBanner(@Param('id') id: string, @Body() b: any) { return this.admin.updateBanner(id, b); }
  @Delete('banners/:id') deleteBanner(@Param('id') id: string) { return this.admin.deleteBanner(id); }

  // Settings
  @Get('commission-rules') listCommissionRules(
    @Query('scope') scope?: string, @Query('categoryId') categoryId?: string,
    @Query('serviceId') serviceId?: string, @Query('cityId') cityId?: string,
  ) { return this.admin.listCommissionRules(scope, categoryId, serviceId, cityId); }
  @Post('commission-rules') createCommissionRule(@Body() b: any) { return this.admin.createCommissionRule(b); }
  @Patch('commission-rules/:id') updateCommissionRule(@Param('id') id: string, @Body() b: any) { return this.admin.updateCommissionRule(id, b); }
  @Delete('commission-rules/:id') deleteCommissionRule(@Param('id') id: string) { return this.admin.deleteCommissionRule(id); }
  @Get('commission-rules/preview') previewCommission(
    @Query('serviceId') serviceId: string, @Query('city') city?: string, @Query('amount') amount?: string,
  ) { return this.admin.previewCommission(serviceId, city, amount ? Number(amount) : undefined); }

  @Get('settings') getSettings(@Query('group') group?: string) { return this.admin.getSettings(group); }
  @Patch('settings/:key') upsertSetting(@Param('key') key: string, @Body() b: { value: string; label?: string; group?: string }) {
    return this.admin.upsertSetting(key, b.value, b.label, b.group);
  }

  // Full stats (replaces stats for dashboard)
  @Get('fullstats') fullStats() { return this.admin.fullStats(); }

  // Newsletters
  @Get('newsletters') newsletters(@Query('q') q?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.admin.listNewsletters({ q, limit: limit ? +limit : 100, offset: offset ? +offset : 0 });
  }
  @Delete('newsletters/:id') deleteNewsletter(@Param('id') id: string) { return this.admin.deleteNewsletter(id); }
  @Get('newsletters/export') exportNewsletters() { return this.admin.exportNewsletters(); }

  // FAQs
  @Get('faqs') faqs(@Query('category') cat?: string) { return this.admin.listFaqs(cat); }
  @Post('faqs') createFaq(@Body() b: any) { return this.admin.createFaq(b); }
  @Patch('faqs/:id') updateFaq(@Param('id') id: string, @Body() b: any) { return this.admin.updateFaq(id, b); }
  @Delete('faqs/:id') deleteFaq(@Param('id') id: string) { return this.admin.deleteFaq(id); }

  // Blogs
  @Get('blogs') blogs(@Query('published') published?: string, @Query('q') q?: string, @Query('limit') limit?: number) {
    const pub = published === 'true' ? true : published === 'false' ? false : undefined;
    return this.admin.listBlogs({ published: pub, q, limit: limit ? +limit : 50 });
  }
  @Post('blogs') createBlog(@Body() b: any) { return this.admin.createBlog(b); }
  @Patch('blogs/:id') updateBlog(@Param('id') id: string, @Body() b: any) { return this.admin.updateBlog(id, b); }
  @Delete('blogs/:id') deleteBlog(@Param('id') id: string) { return this.admin.deleteBlog(id); }

  // Taxes
  @Get('taxes') taxes() { return this.admin.listTaxes(); }
  @Post('taxes') createTax(@Body() b: any) { return this.admin.createTax(b); }
  @Patch('taxes/:id') updateTax(@Param('id') id: string, @Body() b: any) { return this.admin.updateTax(id, b); }
  @Delete('taxes/:id') deleteTax(@Param('id') id: string) { return this.admin.deleteTax(id); }

  // Seasonal Ads
  @Get('ads') ads(@Query('type') type?: string) { return this.admin.listAds(type); }
  @Post('ads') createAd(@Body() b: any) { return this.admin.createAd(b); }
  @Patch('ads/:id') updateAd(@Param('id') id: string, @Body() b: any) { return this.admin.updateAd(id, b); }
  @Delete('ads/:id') deleteAd(@Param('id') id: string) { return this.admin.deleteAd(id); }

  // Staff
  @Get('staff') staff() { return this.admin.listStaff(); }
  @Post('staff') createStaff(@Body() b: any) { return this.admin.createStaff(b); }
  @Patch('staff/:id') updateStaff(@Param('id') id: string, @Body() b: any) { return this.admin.updateStaff(id, b); }
  @Delete('staff/:id') deleteStaff(@Param('id') id: string) { return this.admin.deleteStaff(id); }

  // Reviews
  @Get('reviews') reviews(@Query('q') q?: string, @Query('limit') limit?: number) {
    return this.admin.listReviews({ q, limit: limit ? +limit : 100 });
  }
  @Delete('reviews/:id') deleteReview(@Param('id') id: string) { return this.admin.deleteReview(id); }

  // Coupons
  @Get('coupons') coupons() { return this.admin.listCoupons(); }
  @Post('coupons') createCoupon(@Body() b: any) { return this.admin.createCoupon(b); }
  @Patch('coupons/:id') updateCoupon(@Param('id') id: string, @Body() b: any) { return this.admin.updateCoupon(id, b); }
  @Delete('coupons/:id') deleteCoupon(@Param('id') id: string) { return this.admin.deleteCoupon(id); }

  // Membership plans
  @Get('membership-plans') membershipPlans() { return this.admin.listMembershipPlans(); }
  @Post('membership-plans') createMembershipPlan(@Body() b: any) { return this.admin.createMembershipPlan(b); }
  @Patch('membership-plans/:id') updateMembershipPlan(@Param('id') id: string, @Body() b: any) { return this.admin.updateMembershipPlan(id, b); }

  // CRM Leads (proxy to CRM module data via Prisma)
  @Get('leads') leads(@Query('status') status?: string, @Query('source') source?: string, @Query('q') q?: string, @Query('limit') limit?: number) {
    return this.admin.listLeads({ status, source, q, limit: limit ? +limit : 100 });
  }
  @Get('leads/:id') lead(@Param('id') id: string) { return this.admin.getLead(id); }
  @Patch('leads/:id/status') updateLeadStatus(@Param('id') id: string, @Body() b: { status: string; notes?: string; lostReason?: string }) {
    return this.admin.updateLeadStatus(id, b.status, b.notes, b.lostReason);
  }
  @Patch('leads/:id/assign') assignLead(@Param('id') id: string, @Body() b: { agentId: string }) { return this.admin.assignLead(id, b.agentId); }
  @Delete('leads/:id') deleteLead(@Param('id') id: string) { return this.admin.deleteLead(id); }
  @Get('crm/funnel') crmFunnel() { return this.admin.crmFunnel(); }

  // AMC Plans + Subscriptions
  @Get('amc/plans') amcPlans() { return this.admin.listAmcPlans(); }
  @Post('amc/plans') createAmcPlan(@Body() b: any) { return this.admin.createAmcPlan(b); }
  @Patch('amc/plans/:id') updateAmcPlan(@Param('id') id: string, @Body() b: any) { return this.admin.updateAmcPlan(id, b); }
  @Delete('amc/plans/:id') deleteAmcPlan(@Param('id') id: string) { return this.admin.deleteAmcPlan(id); }
  @Get('amc/subscriptions') amcSubs(@Query('status') status?: string) { return this.admin.listAmcSubscriptions(status); }

  // Invoices
  @Get('invoices') invoiceList(@Query('q') q?: string, @Query('limit') limit?: number) { return this.admin.listInvoices({ q, limit: limit ? +limit : 100 }); }
  @Get('invoices/:id') invoice(@Param('id') id: string) { return this.admin.getInvoice(id); }
  @Post('invoices/:orderId/generate') genInvoice(@Param('orderId') id: string) { return this.admin.generateInvoice(id); }
  @Get('invoices/orders/:orderId/pdf')
  async invoicePdf(@Param('orderId') id: string, @Query('doc') doc: 'CUSTOMER' | 'VENDOR' | 'REMONT' = 'CUSTOMER', @Res() res: Response) {
    const buf = await this.invoices.getPdfBufferAdmin(id, doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${id}-${doc.toLowerCase()}.pdf"`);
    res.send(buf);
  }

  // Corporate Accounts
  @Get('corporate') corporateList() { return this.admin.listCorporate(); }
  @Get('corporate/:id') corporateOne(@Param('id') id: string) { return this.admin.getCorporate(id); }
  @Patch('corporate/:id') updateCorporate(@Param('id') id: string, @Body() b: any) { return this.admin.updateCorporate(id, b); }

  // Wallet Transactions
  @Get('vendor-earnings') vendorEarnings(@Query('q') q?: string, @Query('payoutStatus') payoutStatus?: string) {
    return this.admin.vendorEarningsSummary(q, payoutStatus);
  }
  @Post('vendor-payouts') vendorPayout(
    @CurrentUser() u: JwtPayload,
    @Body() b: { vendorId: string; amount: number; method: SettlementMode; transactionRef?: string; notes?: string },
  ) {
    return this.admin.vendorPayout(u.sub, b.vendorId, b.amount, b.method, b.transactionRef, b.notes);
  }

  @Get('wallet-transactions') walletTx(
    @Query('userId') userId?: string, @Query('type') type?: string,
    @Query('reason') reason?: string, @Query('limit') limit?: number,
  ) {
    return this.admin.listWalletTransactions({ userId, type, reason, limit: limit ? +limit : 100 });
  }
  @Get('wallet-transactions/export') walletExport() { return this.admin.exportWalletTransactions(); }

  // Service Man Enquiries (vendor registrations = vendor pending)
  @Get('servicemen-enquiries') servicemenEnquiries() { return this.admin.listServicemenEnquiries(); }

  // Dashboard alias
  @Get('dashboard') dashboard() { return this.admin.fullStats(); }

  // Customers CRM
  @Get('customers') customers(
    @Query('q') q?: string, @Query('limit') limit?: number,
    @Query('offset') offset?: number, @Query('cityId') cityId?: string,
  ) { return this.admin.listCustomers({ q, limit: limit ? +limit : 100, offset: offset ? +offset : 0, cityId }); }
  @Get('customers/:id') customerOne(@Param('id') id: string) { return this.admin.getCustomer(id); }

  // Reports
  @Get('reports/sales') reportSales(@Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.salesReport({ from, to });
  }
  @Get('reports/orders') reportOrders(
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('status') status?: string,
  ) { return this.admin.ordersReport({ from, to, status }); }
  @Get('reports/vendors') reportVendors() { return this.admin.vendorReport(); }
  @Get('reports/financial') reportFinancial(@Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.financialReport({ from, to });
  }
  @Get('reports/payments-dashboard') paymentsDashboard(
    @Query('from') from?: string, @Query('to') to?: string, @Query('bucket') bucket?: 'day' | 'week' | 'month',
  ) {
    return this.admin.paymentDashboard({ from, to, bucket });
  }
  @Get('orders/:id/ledger') orderLedger(@Param('id') id: string) { return this.admin.getOrderLedger(id); }
  @Get('partners/:vendorId/ledger') partnerLedger(@Param('vendorId') vendorId: string) { return this.admin.getPartnerLedger(vendorId); }

  // Payment Transactions
  @Get('payments') adminPayments(
    @Query('status') status?: string, @Query('gateway') gateway?: string,
    @Query('limit') limit?: number, @Query('offset') offset?: number,
  ) { return this.admin.listPaymentTransactions({ status, gateway, limit: limit ? +limit : 100, offset: offset ? +offset : 0 }); }
  @Patch('payments/:id/mark-failed') markPaymentFailed(@Param('id') id: string, @Body() b: { reason?: string }) {
    return this.admin.markPaymentFailed(id, b?.reason);
  }

  // Integrations
  @Get('integrations') getIntegrations() { return this.admin.getIntegrations(); }
  @Patch('integrations/:group') updateIntegration(@Param('group') group: string, @Body() b: Record<string, string>) {
    return this.admin.updateIntegration(group, b);
  }

  // Review approve
  @Patch('reviews/:id/approve') approveReview(@Param('id') id: string) { return this.admin.approveReview(id); }
}

@Module({
  imports: [PaymentsModule, MasterOrdersModule, SettlementsModule, CitiesModule, PartnerLedgerModule, InvoicesModule, CrmModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
