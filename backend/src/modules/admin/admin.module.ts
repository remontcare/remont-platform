import {
  Module, Injectable, Controller, Get, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole, VendorStatus, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ─── Dashboard ──────────────────────────────────────────────────────

  async globalStats() {
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);

    const [
      totalUsers, totalCustomers, totalServiceVendors, totalProductVendors,
      activeOnlineVendors, pendingVendorApprovals,
      todayOrders, todayGmv, mtdOrders, mtdGmv,
      activeAmc, totalLeads, conversions, totalCities,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: UserRole.CUSTOMER } }),
      this.prisma.serviceVendor.count(),
      this.prisma.productVendor.count(),
      this.prisma.serviceVendor.count({ where: { isOnline: true, status: VendorStatus.ACTIVE } }),
      this.prisma.serviceVendor.count({ where: { status: VendorStatus.PENDING_VERIFICATION } }),
      this.prisma.order.count({ where: { createdAt: { gte: sod } } }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: sod }, paymentStatus: 'PAID' },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({ where: { createdAt: { gte: som } } }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: som }, paymentStatus: 'PAID' },
        _sum: { totalAmount: true },
      }),
      this.prisma.amcSubscription.count({ where: { status: 'ACTIVE' } }),
      this.prisma.lead.count(),
      this.prisma.lead.count({ where: { status: 'CONVERTED' } }),
      this.prisma.city.count({ where: { isActive: true } }),
    ]);

    return {
      users: { total: totalUsers, customers: totalCustomers },
      vendors: {
        service: totalServiceVendors, product: totalProductVendors,
        onlineNow: activeOnlineVendors, pendingApprovals: pendingVendorApprovals,
      },
      orders: {
        today: { count: todayOrders, gmv: todayGmv._sum.totalAmount || 0 },
        thisMonth: { count: mtdOrders, gmv: mtdGmv._sum.totalAmount || 0 },
      },
      amc: { active: activeAmc },
      crm: {
        totalLeads, conversions,
        conversionRate: totalLeads > 0
          ? ((conversions / totalLeads) * 100).toFixed(1) + '%'
          : '0%',
      },
      cities: { active: totalCities },
    };
  }

  // ─── Users ──────────────────────────────────────────────────────────

  async listUsers(opts: { role?: UserRole; q?: string; limit?: number; offset?: number }) {
    return this.prisma.user.findMany({
      where: {
        ...(opts.role ? { role: opts.role } : {}),
        ...(opts.q
          ? {
              OR: [
                { name: { contains: opts.q, mode: 'insensitive' } },
                { phone: { contains: opts.q } },
                { email: { contains: opts.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
      select: {
        id: true, name: true, phone: true, email: true, role: true,
        language: true, isVerified: true, isBlocked: true,
        walletBalance: true, cityId: true, createdAt: true, lastLoginAt: true,
      },
    });
  }

  async blockUser(id: string, block: boolean) {
    return this.prisma.user.update({
      where: { id },
      data: { isBlocked: block },
      select: { id: true, name: true, phone: true, isBlocked: true },
    });
  }

  async adjustWallet(id: string, amount: number, notes: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { walletBalance: { increment: amount } },
        select: { walletBalance: true },
      });
      await tx.walletTransaction.create({
        data: {
          userId: id,
          type: amount >= 0 ? 'CREDIT' : 'DEBIT',
          reason: 'WALLET_TOPUP',
          amount: Math.abs(amount),
          balanceAfter: updated.walletBalance,
          notes: `Admin: ${notes}`,
        },
      });
      return updated;
    });
  }

  // ─── Vendor approval ────────────────────────────────────────────────

  async pendingVendorApprovals() {
    return this.prisma.serviceVendor.findMany({
      where: { status: VendorStatus.PENDING_VERIFICATION },
      include: {
        user: { select: { name: true, phone: true, email: true } },
        documents: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approveVendor(vendorId: string) {
    return this.prisma.serviceVendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.ACTIVE },
    });
  }

  async rejectVendor(vendorId: string, reason: string) {
    return this.prisma.serviceVendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.REJECTED },
    });
  }

  async suspendVendor(vendorId: string) {
    return this.prisma.serviceVendor.update({
      where: { id: vendorId },
      data: { status: VendorStatus.SUSPENDED, isOnline: false },
    });
  }

  // ─── Orders ─────────────────────────────────────────────────────────

  async listOrders(opts: {
    status?: OrderStatus; city?: string; limit?: number; offset?: number;
  }) {
    return this.prisma.order.findMany({
      where: { ...(opts.status ? { status: opts.status } : {}) },
      include: {
        customer: { select: { name: true, phone: true } },
        vendor: { include: { user: { select: { name: true, phone: true } } } },
        service: { select: { name: true } },
        address: { select: { city: true, fullAddress: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
    });
  }

  async forceAssignVendor(orderId: string, vendorId: string) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        vendorId,
        status: OrderStatus.VENDOR_ASSIGNED,
      },
    });
  }

  async refundOrder(orderId: string, reason: string) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.REFUNDED,
        paymentStatus: 'REFUNDED',
        cancelReason: `REFUND: ${reason}`,
      },
    });
  }

  // ─── City activation ────────────────────────────────────────────────

  async toggleCityActive(cityName: string, isActive: boolean) {
    return this.prisma.city.update({
      where: { name: cityName },
      data: { isActive },
    });
  }
}

@ApiTags('Admin')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('stats') stats() { return this.admin.globalStats(); }

  @Get('users')
  users(
    @Query('role') role?: UserRole,
    @Query('q') q?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) { return this.admin.listUsers({ role, q, limit, offset }); }

  @Patch('users/:id/block')
  block(@Param('id') id: string, @Body() b: { block: boolean }) {
    return this.admin.blockUser(id, b.block);
  }

  @Patch('users/:id/wallet')
  wallet(@Param('id') id: string, @Body() b: { amount: number; notes: string }) {
    return this.admin.adjustWallet(id, b.amount, b.notes);
  }

  @Get('vendors/pending') pending() { return this.admin.pendingVendorApprovals(); }

  @Patch('vendors/:id/approve')
  approve(@Param('id') id: string) { return this.admin.approveVendor(id); }

  @Patch('vendors/:id/reject')
  reject(@Param('id') id: string, @Body() b: { reason: string }) {
    return this.admin.rejectVendor(id, b.reason);
  }

  @Patch('vendors/:id/suspend')
  suspend(@Param('id') id: string) { return this.admin.suspendVendor(id); }

  @Get('orders')
  orders(
    @Query('status') status?: OrderStatus,
    @Query('city') city?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) { return this.admin.listOrders({ status, city, limit, offset }); }

  @Patch('orders/:id/assign-vendor')
  assignVendor(@Param('id') id: string, @Body() b: { vendorId: string }) {
    return this.admin.forceAssignVendor(id, b.vendorId);
  }

  @Patch('orders/:id/refund')
  refund(@Param('id') id: string, @Body() b: { reason: string }) {
    return this.admin.refundOrder(id, b.reason);
  }

  @Patch('cities/:name/toggle')
  toggleCity(@Param('name') name: string, @Body() b: { isActive: boolean }) {
    return this.admin.toggleCityActive(name, b.isActive);
  }
}

@Module({
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
