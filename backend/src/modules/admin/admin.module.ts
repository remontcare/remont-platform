import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsPhoneNumber, IsOptional } from 'class-validator';
import { UserRole, VendorStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, slugify } from '../../common';
import { openAiComplete, parseAiJson } from '../ai-agent/openai-client';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';

// Validated like auth.module.ts's SendOtpDto/VerifyOtpDto — this endpoint creates a User row
// that must be able to log in via the real OTP flow, so an invalid phone must be rejected up
// front rather than silently creating a seller who can never log in.
export class CreateProductVendorDto {
  @IsString() @IsPhoneNumber('IN') phone: string;
  @IsString() name: string;
  @IsString() businessName: string;
  @IsOptional() @IsString() gstNumber?: string;
  @IsOptional() @IsString() city?: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly openaiKey: string;
  private readonly openaiModel: string;

  constructor(private prisma: PrismaService, private config: ConfigService, private payments: PaymentsService) {
    this.openaiKey = config.get('OPENAI_API_KEY', '');
    this.openaiModel = config.get('OPENAI_MODEL', 'gpt-4o-mini');
  }

  // ─── Dashboard stats ────────────────────────────────────────────────

  async globalStats() {
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);

    const [
      totalUsers, totalCustomers, totalServiceVendors, totalProductVendors,
      activeOnlineVendors, pendingVendorApprovals,
      todayOrders, todayGmv, mtdOrders, mtdGmv,
      activeAmc, totalLeads, conversions, totalCities,
      totalServices, totalProducts,
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
    ]);

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

    // Top services
    const topServices = await this.prisma.order.groupBy({
      by: ['serviceId'],
      where: { createdAt: { gte: since }, serviceId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });
    const svcDetails = await Promise.all(
      topServices.map(async (t) => {
        const svc = t.serviceId ? await this.prisma.service.findUnique({ where: { id: t.serviceId }, select: { name: true } }) : null;
        return { name: svc?.name || 'Unknown', orders: t._count.id };
      }),
    );

    return {
      daily: Object.values(byDay),
      statusBreakdown: statusCounts,
      topServices: svcDetails,
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

  async blockUser(id: string, block: boolean) {
    return this.prisma.user.update({ where: { id }, data: { isBlocked: block }, select: { id: true, name: true, phone: true, isBlocked: true } });
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

  async allVendors(opts: { status?: VendorStatus; q?: string; limit?: number }) {
    return this.prisma.serviceVendor.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.q ? { OR: [{ fullName: { contains: opts.q, mode: 'insensitive' } }, { businessName: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      include: { user: { select: { name: true, phone: true, email: true } } },
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

    // Same pattern as AuthService.adminPinLogin(): upsert the User directly with the target
    // role, isVerified:true. The seller then logs in through the normal /auth/send-otp +
    // /auth/verify-otp flow — no separate password system needed for sellers.
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
        status: VendorStatus.ACTIVE,
      },
      include: { user: { select: { name: true, phone: true } } },
    });
  }

  async suspendProductVendor(id: string) {
    return this.prisma.productVendor.update({ where: { id }, data: { status: VendorStatus.SUSPENDED } });
  }

  async activateProductVendor(id: string) {
    return this.prisma.productVendor.update({ where: { id }, data: { status: VendorStatus.ACTIVE } });
  }

  // ─── Orders ─────────────────────────────────────────────────────────

  async orderStats() {
    const [total, newOrders, active, completed, cancelled, revenue] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.order.count({ where: { status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] } } }),
      this.prisma.order.count({ where: { status: { in: ['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED'] } } }),
      this.prisma.order.count({ where: { status: 'COMPLETED' } }),
      this.prisma.order.count({ where: { status: 'CANCELLED' } }),
      this.prisma.order.aggregate({ _sum: { totalAmount: true }, where: { paymentStatus: 'PAID' } }),
    ]);
    return { total, new: newOrders, active, completed, cancelled, revenue: Number(revenue._sum.totalAmount || 0) };
  }

  async listOrders(opts: { status?: string; city?: string; q?: string; channel?: string; limit?: number; offset?: number }) {
    const where: any = {
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
        vendor: { select: { id: true, fullName: true, user: { select: { name: true, phone: true } } } },
        service: { select: { name: true, basePrice: true, durationMinutes: true } },
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
        address: true,
        items: { include: { product: { select: { name: true, sku: true, images: true } } } },
        extraWorkItems: true,
        invoice: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async adminCreateOrder(data: {
    serviceId: string; cityId: string; slotDate: string; slotTime: string;
    guestName: string; guestPhone: string; guestEmail?: string;
    fullAddress: string; notes?: string; channel?: string;
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

    const cityService = await this.prisma.cityService.findUnique({
      where: { cityId_serviceId: { cityId: data.cityId, serviceId: data.serviceId } },
    });
    const serviceAmount = (cityService?.isActive && cityService.customPrice)
      ? Number(cityService.customPrice) : Number(svc.basePrice);
    const gstAmount = Math.round(serviceAmount * 0.18 * 100) / 100;

    const [h, m] = data.slotTime.split(':').map(Number);
    const slotStart = new Date(data.slotDate); slotStart.setHours(h, m || 0, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + svc.durationMinutes * 60000);

    const address = await this.prisma.address.create({
      data: { userId: user.id, label: 'Booking', fullAddress: data.fullAddress, city: city.name, state: city.state, pincode: '000000', latitude: city.latitude, longitude: city.longitude, isDefault: false },
    });

    const count = await this.prisma.order.count();
    const orderNumber = (await import('../../common')).generateOrderNumber('REM', count);
    return this.prisma.order.create({
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
        remontCommission: Math.round(serviceAmount * 0.15 * 100) / 100,
        vendorPayout: serviceAmount - Math.round(serviceAmount * 0.15 * 100) / 100,
      },
      include: { service: true, address: true, customer: { select: { name: true, phone: true } } },
    });
  }

  async forceAssignVendor(orderId: string, vendorId: string) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { vendorId, status: OrderStatus.VENDOR_ASSIGNED },
      include: { vendor: { include: { user: { select: { name: true, phone: true } } } } },
    });
  }

  async adminUpdateStatus(orderId: string, status: string, note?: string) {
    const validStatuses = ['PENDING_PAYMENT', 'CONFIRMED', 'VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS', 'EXTRA_WORK_ADDED', 'COMPLETED', 'INVOICED', 'CLOSED', 'CANCELLED', 'REFUNDED'];
    if (!validStatuses.includes(status)) throw new BadRequestException(`Invalid status: ${status}`);
    const data: any = { status };
    if (note) data.adminNotes = note;
    if (status === 'COMPLETED') data.completedAt = new Date();
    if (status === 'CANCELLED') { data.cancelledAt = new Date(); if (note) data.cancelReason = note; }
    if (status === 'REFUNDED') data.paymentStatus = 'REFUNDED';
    const updated = await this.prisma.order.update({ where: { id: orderId }, data });
    if (status === 'COMPLETED') this.autoGenerateInvoice(orderId).catch(() => {});
    return updated;
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
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'INVOICED' as any } });
  }

  async adminUpdateNote(orderId: string, note: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { adminNotes: note } });
  }

  async listActiveVendors(skill?: string) {
    return this.prisma.serviceVendor.findMany({
      where: {
        status: 'ACTIVE',
        ...(skill ? { skills: { has: skill } } : {}),
      },
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { rating: 'desc' },
      take: 100,
    });
  }

  async adminCancelOrder(orderId: string, reason: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: `Admin: ${reason}`, adminNotes: reason } });
  }

  async refundOrder(orderId: string, reason: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.REFUNDED, paymentStatus: 'REFUNDED', cancelReason: `REFUND: ${reason}`, adminNotes: reason } });
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

  async adminListProducts(opts: { q?: string; categoryId?: string; isActive?: boolean; limit?: number; offset?: number }) {
    return this.prisma.product.findMany({
      where: {
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
        ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: 'insensitive' } }, { sku: { contains: opts.q, mode: 'insensitive' } }, { brand: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      include: { vendor: { select: { businessName: true, status: true } }, category: { select: { name: true, key: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
      skip: opts.offset || 0,
    });
  }

  async adminCreateProduct(data: any) {
    const slug = slugify(data.name) + '-' + Date.now();
    const sku = data.sku || 'RMNT-' + Date.now();
    return this.prisma.product.create({
      data: { ...data, slug, sku, images: data.images || [], seoKeywords: data.seoKeywords || [], aiEnhancedImgs: [] },
      include: { category: { select: { name: true } } },
    });
  }

  async adminUpdateProduct(id: string, data: any) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    return this.prisma.product.update({ where: { id }, data, include: { category: { select: { name: true } } } });
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

  async generateAiContent(type: 'SERVICE' | 'PRODUCT' | 'CATEGORY', name: string, context?: string) {
    if (this.openaiKey) {
      try {
        const prompt = `Generate content for a Remont India home services listing:
Type: ${type}
Name: ${name}
${context ? `Context: ${context}` : ''}

Return JSON with:
- description: 2-3 sentence professional description (60-80 words)
- seoTitle: SEO title (50-60 chars)
- seoDesc: meta description (140-155 chars)
- seoKeywords: array of 5 relevant keywords
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
    const seoTitle = `${name} | Best ${name} Service in India | Remont India`;
    const seoDesc = `Book ${name} online at the best price. Certified professionals, doorstep service, 100% satisfaction guarantee. Available in 11+ cities across India.`;
    const seoKeywords = [name.toLowerCase(), 'home service', 'doorstep service', 'remont india', 'book online'];
    const faq = [
      { q: `How long does ${name} take?`, a: 'Our certified technicians typically complete the service in 60–90 minutes depending on the scope of work.' },
      { q: `Is ${name} available in my city?`, a: 'We are available in Mumbai, Delhi, Bangalore, Hyderabad, Pune, Chennai, Kolkata, Ahmedabad, Jaipur, Lucknow, and Indore.' },
      { q: `What is included in ${name}?`, a: `The ${name} package includes a thorough inspection, cleaning, repair if required, and a service report. All work is backed by a 30-day service guarantee.` },
      { q: `How do I book ${name}?`, a: 'Visit remontindia.com, select your city and service, choose a time slot, and pay online. Our professional will arrive at the scheduled time.' },
    ];
    return { description, seoTitle, seoDesc, seoKeywords, faq };
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

  async generateInvoice(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { extraWorkItems: { where: { customerApproved: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    const existing = await this.prisma.invoice.findUnique({ where: { orderId } });
    if (existing) return existing;

    const customerSubtotal = Number(order.subtotal);
    const customerTotal = Number(order.totalAmount);
    const customerCgst = Math.round((Number(order.gstAmount) / 2) * 100) / 100;
    const customerSgst = customerCgst;
    const vendorLabor = Number(order.serviceAmount) + order.extraWorkItems.reduce((s, e) => s + Number(e.amount), 0);
    const vendorMaterial = 0;
    const vendorPretax = vendorLabor + vendorMaterial;
    const vendorCgst = Math.round(vendorPretax * 0.09 * 100) / 100;
    const vendorSgst = vendorCgst;
    const vendorTotal = vendorPretax + vendorCgst + vendorSgst;
    const platformCommission = Number(order.remontCommission);
    const bookingFee = 49;
    const remontPretax = platformCommission + bookingFee;
    const remontCgst = Math.round(remontPretax * 0.09 * 100) / 100;
    const remontSgst = remontCgst;
    const remontTotal = remontPretax + remontCgst + remontSgst;
    const count = await this.prisma.invoice.count();
    const invoiceNumber = `INV-${order.orderNumber}-${(count + 1).toString().padStart(4, '0')}`;

    return this.prisma.invoice.create({
      data: {
        invoiceNumber, orderId,
        customerSubtotal, customerCgst, customerSgst, customerTotal,
        vendorLabor, vendorMaterial, vendorCgst, vendorSgst, vendorTotal,
        platformCommission, bookingFee, remontCgst, remontSgst, remontTotal,
      },
    });
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

  async listWalletTransactions(opts: { userId?: string; type?: string; limit?: number }) {
    return this.prisma.walletTransaction.findMany({
      where: {
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(opts.type ? { type: opts.type as any } : {}),
      },
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
    });
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
    return this.prisma.serviceVendor.findMany({
      where: { status: { in: ['PENDING', 'UNDER_REVIEW'] as any } },
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
    const [orders, revenue, byStatus, topProducts, byChannel] = await Promise.all([
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
        where: { order: { createdAt: { gte: from, lte: to } } },
        _count: { id: true },
        _sum: { totalPrice: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.prisma.order.groupBy({ by: ['channel'], where: { createdAt: { gte: from, lte: to } }, _count: true }),
    ]);
    return {
      period: { from, to },
      summary: {
        totalOrders: orders,
        totalRevenue: Number(revenue._sum.totalAmount || 0),
        platformCommission: Number(revenue._sum.remontCommission || 0),
      },
      byStatus,
      topProducts,
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
    return { transactions, total };
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
  constructor(private admin: AdminService) {}

  // Dashboard
  @Get('stats') stats() { return this.admin.globalStats(); }
  @Get('analytics') analytics(@Query('days') days?: number) { return this.admin.getAnalytics(days ? +days : 30); }

  // Seed
  @Post('seed') seed() { return this.admin.seedData(); }

  // Users
  @Get('users') users(@Query('role') role?: UserRole, @Query('q') q?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.admin.listUsers({ role, q, limit, offset });
  }
  @Patch('users/:id/block') block(@Param('id') id: string, @Body() b: { block: boolean }) { return this.admin.blockUser(id, b.block); }
  @Patch('users/:id/wallet') wallet(@Param('id') id: string, @Body() b: { amount: number; notes: string }) { return this.admin.adjustWallet(id, b.amount, b.notes); }

  // Vendors
  @Get('vendors/pending') pending() { return this.admin.pendingVendorApprovals(); }
  @Get('vendors') allVendors(@Query('status') status?: VendorStatus, @Query('q') q?: string, @Query('limit') limit?: number) { return this.admin.allVendors({ status, q, limit }); }
  @Patch('vendors/:id/approve') approve(@Param('id') id: string) { return this.admin.approveVendor(id); }
  @Patch('vendors/:id/reject') reject(@Param('id') id: string, @Body() b: { reason: string }) { return this.admin.rejectVendor(id, b.reason); }
  @Patch('vendors/:id/suspend') suspend(@Param('id') id: string) { return this.admin.suspendVendor(id); }

  @Get('product-vendors') listProductVendors(@Query('status') status?: VendorStatus, @Query('q') q?: string, @Query('limit') limit?: number) {
    return this.admin.listProductVendors({ status, q, limit });
  }
  @Post('product-vendors') createProductVendor(@Body() b: CreateProductVendorDto) {
    return this.admin.createProductVendor(b);
  }
  @Patch('product-vendors/:id/suspend') suspendProductVendor(@Param('id') id: string) { return this.admin.suspendProductVendor(id); }
  @Patch('product-vendors/:id/activate') activateProductVendor(@Param('id') id: string) { return this.admin.activateProductVendor(id); }

  // Orders
  // Orders — stats + list + management
  @Get('orders/stats') orderStats() { return this.admin.orderStats(); }
  @Get('orders/vendors') orderVendors(@Query('skill') skill?: string) { return this.admin.listActiveVendors(skill); }
  @Get('orders') listOrders(
    @Query('status') status?: string, @Query('city') city?: string, @Query('q') q?: string,
    @Query('channel') channel?: string, @Query('limit') limit?: number, @Query('offset') offset?: number,
  ) { return this.admin.listOrders({ status, city, q, channel, limit, offset }); }
  @Post('orders') adminCreateOrder(@Body() b: any) { return this.admin.adminCreateOrder(b); }
  @Get('orders/:id') adminGetOrder(@Param('id') id: string) { return this.admin.adminGetOrder(id); }
  @Patch('orders/:id/status') updateOrderStatus(@Param('id') id: string, @Body() b: { status: string; note?: string }) { return this.admin.adminUpdateStatus(id, b.status, b.note); }
  @Patch('orders/:id/note') updateOrderNote(@Param('id') id: string, @Body() b: { note: string }) { return this.admin.adminUpdateNote(id, b.note); }
  @Patch('orders/:id/assign-vendor') assignVendor(@Param('id') id: string, @Body() b: { vendorId: string }) { return this.admin.forceAssignVendor(id, b.vendorId); }
  @Patch('orders/:id/cancel') cancelOrder(@Param('id') id: string, @Body() b: { reason: string }) { return this.admin.adminCancelOrder(id, b.reason); }
  @Patch('orders/:id/refund') refund(@Param('id') id: string, @Body() b: { reason: string }) { return this.admin.refundOrder(id, b.reason); }
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
  @Delete('services/all') deleteAllServices() { return this.admin.deleteAllServices(); }
  @Delete('services/:id') deleteService(@Param('id') id: string) { return this.admin.deleteService(id); }
  @Get('services/:id/cities') serviceCities(@Param('id') id: string) { return this.admin.listServiceCities(id); }
  @Patch('services/:id/cities/:cityId') upsertServiceCity(@Param('id') sid: string, @Param('cityId') cid: string, @Body() b: { isActive: boolean; customPrice?: number }) {
    return this.admin.upsertServiceCity(sid, cid, b);
  }

  // Product Categories
  @Get('product-categories') listProductCats() { return this.admin.listProductCategories(); }
  @Post('product-categories') createProductCat(@Body() b: any) { return this.admin.createProductCategory(b); }
  @Patch('product-categories/:id') updateProductCat(@Param('id') id: string, @Body() b: any) { return this.admin.updateProductCategory(id, b); }
  @Delete('product-categories/:id') deleteProductCat(@Param('id') id: string) { return this.admin.deleteProductCategory(id); }

  // Products
  @Get('products/export') exportProds() { return this.admin.exportProducts(); }
  @Get('products') allProducts(@Query('q') q?: string, @Query('categoryId') catId?: string, @Query('isActive') ia?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    const isActive = ia === 'true' ? true : ia === 'false' ? false : undefined;
    return this.admin.adminListProducts({ q, categoryId: catId, isActive, limit: limit ? +limit : 100, offset: offset ? +offset : 0 });
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

  // Banners (CMS)
  @Get('banners') listBanners() { return this.admin.listBanners(); }
  @Post('banners') createBanner(@Body() b: any) { return this.admin.createBanner(b); }
  @Patch('banners/:id') updateBanner(@Param('id') id: string, @Body() b: any) { return this.admin.updateBanner(id, b); }
  @Delete('banners/:id') deleteBanner(@Param('id') id: string) { return this.admin.deleteBanner(id); }

  // Settings
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
  @Get('invoices') invoices(@Query('q') q?: string, @Query('limit') limit?: number) { return this.admin.listInvoices({ q, limit: limit ? +limit : 100 }); }
  @Get('invoices/:id') invoice(@Param('id') id: string) { return this.admin.getInvoice(id); }
  @Post('invoices/:orderId/generate') genInvoice(@Param('orderId') id: string) { return this.admin.generateInvoice(id); }

  // Corporate Accounts
  @Get('corporate') corporateList() { return this.admin.listCorporate(); }
  @Get('corporate/:id') corporateOne(@Param('id') id: string) { return this.admin.getCorporate(id); }
  @Patch('corporate/:id') updateCorporate(@Param('id') id: string, @Body() b: any) { return this.admin.updateCorporate(id, b); }

  // Wallet Transactions
  @Get('wallet-transactions') walletTx(@Query('userId') userId?: string, @Query('type') type?: string, @Query('limit') limit?: number) {
    return this.admin.listWalletTransactions({ userId, type, limit: limit ? +limit : 100 });
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

  // Payment Transactions
  @Get('payments') adminPayments(
    @Query('status') status?: string, @Query('gateway') gateway?: string,
    @Query('limit') limit?: number, @Query('offset') offset?: number,
  ) { return this.admin.listPaymentTransactions({ status, gateway, limit: limit ? +limit : 100, offset: offset ? +offset : 0 }); }

  // Integrations
  @Get('integrations') getIntegrations() { return this.admin.getIntegrations(); }
  @Patch('integrations/:group') updateIntegration(@Param('group') group: string, @Body() b: Record<string, string>) {
    return this.admin.updateIntegration(group, b);
  }

  // Review approve
  @Patch('reviews/:id/approve') approveReview(@Param('id') id: string) { return this.admin.approveReview(id); }
}

@Module({
  imports: [PaymentsModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
