import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Req,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SettlementMode, UserRole } from '@prisma/client';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';
import { ProductSettlementsService } from './product-settlements.service';
import { PrismaService } from '../../prisma/prisma.module';

@ApiTags('Product Settlements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('product-settlements')
export class ProductSettlementsController {
  constructor(
    private service: ProductSettlementsService,
    private prisma: PrismaService,
  ) {}

  /**
   * Seller: View their settlement summary (earnings, pending payouts)
   */
  @Get('me/summary')
  @ApiOperation({ summary: 'Get my settlement summary' })
  async mySummary(@CurrentUser() user: JwtPayload) {
    const vendor = await this.prisma.productVendor.findUnique({
      where: { userId: user.sub },
    });
    if (!vendor) throw new Error('Seller profile not found');
    return this.service.summaryForVendor(vendor.id);
  }

  /**
   * Seller: View their settlement history
   */
  @Get('me')
  @ApiOperation({ summary: 'Get my settlements' })
  async myList(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit: number = 50,
  ) {
    const vendor = await this.prisma.productVendor.findUnique({
      where: { userId: user.sub },
    });
    if (!vendor) throw new Error('Seller profile not found');
    return this.service.listForVendor(vendor.id, limit);
  }

  /**
   * Seller: Request a payout settlement
   */
  @Post('me/request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a settlement payout' })
  async requestSettlement(
    @CurrentUser() user: JwtPayload,
    @Body() body: { amount: number; mode: SettlementMode; notes?: string },
  ) {
    const vendor = await this.prisma.productVendor.findUnique({
      where: { userId: user.sub },
    });
    if (!vendor) throw new Error('Seller profile not found');

    return this.service.requestSettlement(
      vendor.id,
      body.amount,
      body.mode,
      body.notes,
    );
  }

  /**
   * Admin: Get all pending settlements (for review)
   */
  @Get('pending')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get pending settlements (admin)' })
  async getPending(@Query('limit') limit: number = 100) {
    return this.service.listPending(limit);
  }

  /**
   * Admin: List all settlements with filters
   */
  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all settlements (admin)' })
  async listAll(
    @Query('vendorId') vendorId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit: number = 100,
  ) {
    return this.service.listAll(
      vendorId,
      status,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
      limit,
    );
  }

  /**
   * Admin: Approve a pending settlement
   */
  @Patch(':settlementId/approve')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve settlement (admin)' })
  async approve(
    @Param('settlementId') settlementId: string,
    @CurrentUser() admin: JwtPayload,
    @Body() body: { adjustedAmount?: number; notes?: string },
  ) {
    return this.service.approveSettlement(
      settlementId,
      admin.sub,
      body.adjustedAmount,
      body.notes,
    );
  }

  /**
   * Admin: Mark settlement as completed (money sent)
   */
  @Patch(':settlementId/mark-completed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Mark settlement as completed (admin)' })
  async markCompleted(
    @Param('settlementId') settlementId: string,
    @CurrentUser() admin: JwtPayload,
    @Body() body: { referenceNumber?: string },
  ) {
    return this.service.markAsCompleted(
      settlementId,
      admin.sub,
      body.referenceNumber,
    );
  }

  /**
   * Admin: Mark settlement as failed
   */
  @Patch(':settlementId/mark-failed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Mark settlement as failed (admin)' })
  async markFailed(
    @Param('settlementId') settlementId: string,
    @Body() body: { failureReason: string },
  ) {
    return this.service.markAsFailed(settlementId, body.failureReason);
  }
}
