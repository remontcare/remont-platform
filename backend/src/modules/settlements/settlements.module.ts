import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SettlementMode, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';

// Manual partner-payout record-keeping (no payout gateway is configured — see
// PartnerSettlement in schema.prisma). Recording a settlement here does not move
// money itself; it documents that admin already paid the partner outside the
// platform and reduces ServiceVendor.pendingPayout so the dashboards stay accurate.
@Injectable()
export class SettlementsService {
  constructor(private prisma: PrismaService) {}

  async record(
    vendorId: string,
    amount: number,
    mode: SettlementMode,
    paidBy: string,
    referenceNumber?: string,
    notes?: string,
  ) {
    if (!amount || amount <= 0) throw new BadRequestException('Enter a valid settlement amount');
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Partner not found');
    if (amount > Number(vendor.pendingPayout)) {
      throw new BadRequestException(
        `Amount exceeds pending payout (₹${vendor.pendingPayout} available)`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const settlement = await tx.partnerSettlement.create({
        data: { vendorId, amount, mode, referenceNumber, notes, paidBy },
      });
      await tx.serviceVendor.update({
        where: { id: vendorId },
        data: { pendingPayout: { decrement: amount } },
      });
      return settlement;
    });
  }

  async listForVendor(vendorId: string, limit = 50) {
    return this.prisma.partnerSettlement.findMany({
      where: { vendorId },
      orderBy: { paidAt: 'desc' },
      take: limit,
    });
  }

  // "Me" routes are authenticated by User.id (JWT sub), not ServiceVendor.id — resolve
  // once here, same convention as ServiceVendorsService in vendors.module.ts.
  private async resolveVendorId(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    return v.id;
  }

  async summaryForUser(userId: string) {
    return this.summaryForVendor(await this.resolveVendorId(userId));
  }

  async listForUser(userId: string, limit = 50) {
    return this.listForVendor(await this.resolveVendorId(userId), limit);
  }

  async listAll(vendorId?: string, from?: Date, to?: Date, limit = 100) {
    return this.prisma.partnerSettlement.findMany({
      where: {
        ...(vendorId ? { vendorId } : {}),
        ...(from || to ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { paidAt: 'desc' },
      take: limit,
    });
  }

  /** Amount received (lifetime completed-job payout) vs. still pending, for a partner's own dashboard. */
  async summaryForVendor(vendorId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({
      where: { id: vendorId },
      select: { totalEarnings: true, pendingPayout: true },
    });
    if (!vendor) throw new NotFoundException('Partner not found');
    const paidOut = Number(vendor.totalEarnings) - Number(vendor.pendingPayout);
    return {
      totalEarnings: vendor.totalEarnings,
      paidOut,
      pendingPayout: vendor.pendingPayout,
    };
  }
}

@ApiTags('Settlements')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('settlements')
export class SettlementsController {
  constructor(private s: SettlementsService) {}

  // Partner's own view of their earnings/settlement status.
  @Get('me/summary')
  mySummary(@CurrentUser() u: JwtPayload) {
    return this.s.summaryForUser(u.sub);
  }

  @Get('me')
  myList(@CurrentUser() u: JwtPayload) {
    return this.s.listForUser(u.sub);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  adminList(@Query('vendorId') vendorId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.s.listAll(vendorId, from ? new Date(from) : undefined, to ? new Date(to) : undefined);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('vendor/:vendorId')
  adminListForVendor(@Param('vendorId') vendorId: string) {
    return this.s.listForVendor(vendorId);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post()
  adminRecord(
    @CurrentUser() u: JwtPayload,
    @Body() b: { vendorId: string; amount: number; mode: SettlementMode; referenceNumber?: string; notes?: string },
  ) {
    return this.s.record(b.vendorId, b.amount, b.mode, u.sub, b.referenceNumber, b.notes);
  }
}

@Module({
  controllers: [SettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
