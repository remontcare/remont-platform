import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole, VendorStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, slugify } from '../../common';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

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
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { status: VendorStatus.REJECTED } });
  }

  async suspendVendor(vendorId: string) {
    return this.prisma.serviceVendor.update({ where: { id: vendorId }, data: { status: VendorStatus.SUSPENDED, isOnline: false } });
  }

  // ─── Orders ─────────────────────────────────────────────────────────

  async listOrders(opts: { status?: OrderStatus; city?: string; limit?: number; offset?: number }) {
    return this.prisma.order.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.city ? { address: { city: { contains: opts.city, mode: 'insensitive' } } } : {}),
      },
      include: {
        customer: { select: { name: true, phone: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        service: { select: { name: true, basePrice: true } },
        address: { select: { city: true, fullAddress: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
    });
  }

  async forceAssignVendor(orderId: string, vendorId: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { vendorId, status: OrderStatus.VENDOR_ASSIGNED } });
  }

  async adminCancelOrder(orderId: string, reason: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, cancelReason: `Admin: ${reason}` } });
  }

  async refundOrder(orderId: string, reason: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.REFUNDED, paymentStatus: 'REFUNDED', cancelReason: `REFUND: ${reason}` } });
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

  // ─── Service Categories ──────────────────────────────────────────────

  async listAllCategories() {
    return this.prisma.serviceCategory.findMany({
      include: { services: { where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, basePrice: true, originalPrice: true, durationMinutes: true, isPopular: true } } },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createCategory(data: { key: string; name: string; icon: string; description?: string; sortOrder?: number; isPremium?: boolean }) {
    return this.prisma.serviceCategory.create({ data });
  }

  async updateCategory(id: string, data: { name?: string; icon?: string; description?: string; sortOrder?: number; isActive?: boolean; isPremium?: boolean }) {
    const existing = await this.prisma.serviceCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    return this.prisma.serviceCategory.update({ where: { id }, data });
  }

  async deleteCategory(id: string) {
    const svcCount = await this.prisma.service.count({ where: { categoryId: id } });
    if (svcCount > 0) throw new BadRequestException(`Cannot delete: ${svcCount} services use this category`);
    return this.prisma.serviceCategory.delete({ where: { id } });
  }

  // ─── Services ───────────────────────────────────────────────────────

  async listAllServices(categoryId?: string) {
    return this.prisma.service.findMany({
      where: { ...(categoryId ? { categoryId } : {}) },
      include: { category: { select: { name: true, key: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createService(data: { categoryId: string; name: string; description?: string; basePrice: number; originalPrice?: number; durationMinutes?: number; isPopular?: boolean; isPremium?: boolean; imageUrl?: string; requiredSkills?: string[] }) {
    const slug = slugify(data.name) + '-' + Date.now();
    return this.prisma.service.create({
      data: { ...data, slug, requiredSkills: data.requiredSkills || [], basePrice: data.basePrice },
      include: { category: true },
    });
  }

  async updateService(id: string, data: { name?: string; description?: string; basePrice?: number; originalPrice?: number; durationMinutes?: number; isActive?: boolean; isPopular?: boolean; isPremium?: boolean; imageUrl?: string; requiredSkills?: string[] }) {
    const existing = await this.prisma.service.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Service not found');
    return this.prisma.service.update({ where: { id }, data, include: { category: true } });
  }

  async deleteService(id: string) {
    const orderCount = await this.prisma.order.count({ where: { serviceId: id } });
    if (orderCount > 0) {
      return this.prisma.service.update({ where: { id }, data: { isActive: false } });
    }
    return this.prisma.service.delete({ where: { id } });
  }

  // ─── Product Categories ──────────────────────────────────────────────

  async listProductCategories() {
    return this.prisma.productCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async createProductCategory(data: { key: string; name: string; icon?: string; sortOrder?: number }) {
    return this.prisma.productCategory.create({ data });
  }

  // ─── Products ───────────────────────────────────────────────────────

  async adminListProducts(opts: { q?: string; categoryId?: string; limit?: number; offset?: number }) {
    return this.prisma.product.findMany({
      where: {
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: 'insensitive' } }, { sku: { contains: opts.q, mode: 'insensitive' } }, { brand: { contains: opts.q, mode: 'insensitive' } }] } : {}),
      },
      include: { vendor: { select: { businessName: true, status: true } }, category: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 100,
      skip: opts.offset || 0,
    });
  }

  async adminUpdateProduct(id: string, data: { name?: string; description?: string; price?: number; mrp?: number; stock?: number; isActive?: boolean; brand?: string; images?: string[]; categoryId?: string }) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    return this.prisma.product.update({ where: { id }, data });
  }

  async adminDeleteProduct(id: string) {
    return this.prisma.product.update({ where: { id }, data: { isActive: false } });
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
      { key: 'support_phone', value: '+91 98765 43210', label: 'Support Phone', group: 'contact' },
      { key: 'support_email', value: 'support@remontindia.com', label: 'Support Email', group: 'contact' },
      { key: 'whatsapp_number', value: '+919876543210', label: 'WhatsApp Number', group: 'contact' },
      { key: 'total_cities', value: '32', label: 'Total Cities (shown on homepage)', group: 'stats' },
      { key: 'total_reviews', value: '50000', label: 'Total Reviews (shown on homepage)', group: 'stats' },
      { key: 'total_vendors', value: '5000', label: 'Total Vendors (shown on homepage)', group: 'stats' },
    ];
    for (const s of settings) {
      await this.prisma.siteSetting.upsert({ where: { key: s.key }, create: s, update: { value: s.value } });
    }
    results.push(`✓ Default settings upserted`);

    return { success: true, results };
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

  // Orders
  @Get('orders') orders(@Query('status') status?: OrderStatus, @Query('city') city?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.admin.listOrders({ status, city, limit, offset });
  }
  @Patch('orders/:id/assign-vendor') assignVendor(@Param('id') id: string, @Body() b: { vendorId: string }) { return this.admin.forceAssignVendor(id, b.vendorId); }
  @Patch('orders/:id/cancel') cancelOrder(@Param('id') id: string, @Body() b: { reason: string }) { return this.admin.adminCancelOrder(id, b.reason); }
  @Patch('orders/:id/refund') refund(@Param('id') id: string, @Body() b: { reason: string }) { return this.admin.refundOrder(id, b.reason); }

  // Cities
  @Get('cities') cities() { return this.admin.listCities(); }
  @Post('cities') createCity(@Body() b: any) { return this.admin.createCity(b); }
  @Patch('cities/:name') updateCity(@Param('name') name: string, @Body() b: any) { return this.admin.updateCity(name, b); }
  @Patch('cities/:name/toggle') toggleCity(@Param('name') name: string, @Body() b: { isActive: boolean }) { return this.admin.toggleCityActive(name, b.isActive); }

  // Service Categories
  @Get('services/categories') allCategories() { return this.admin.listAllCategories(); }
  @Post('services/categories') createCategory(@Body() b: any) { return this.admin.createCategory(b); }
  @Patch('services/categories/:id') updateCategory(@Param('id') id: string, @Body() b: any) { return this.admin.updateCategory(id, b); }
  @Delete('services/categories/:id') deleteCategory(@Param('id') id: string) { return this.admin.deleteCategory(id); }

  // Services
  @Get('services') allServices(@Query('categoryId') categoryId?: string) { return this.admin.listAllServices(categoryId); }
  @Post('services') createService(@Body() b: any) { return this.admin.createService(b); }
  @Patch('services/:id') updateService(@Param('id') id: string, @Body() b: any) { return this.admin.updateService(id, b); }
  @Delete('services/:id') deleteService(@Param('id') id: string) { return this.admin.deleteService(id); }

  // Product Categories
  @Get('product-categories') listProductCats() { return this.admin.listProductCategories(); }
  @Post('product-categories') createProductCat(@Body() b: any) { return this.admin.createProductCategory(b); }

  // Products
  @Get('products') allProducts(@Query('q') q?: string, @Query('categoryId') categoryId?: string, @Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.admin.adminListProducts({ q, categoryId, limit, offset });
  }
  @Patch('products/:id') updateProduct(@Param('id') id: string, @Body() b: any) { return this.admin.adminUpdateProduct(id, b); }
  @Delete('products/:id') deleteProduct(@Param('id') id: string) { return this.admin.adminDeleteProduct(id); }

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
}

@Module({
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
