import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LedgerEntryType, WithdrawalStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';

// Phase 2 — per-partner ledger + withdrawal requests. Same single-entry-with-
// running-balance idiom as WalletTransaction (wallet.module.ts), just
// vendorId-keyed with a richer category enum. Deliberately NOT a double-entry
// accounting engine — see plan doc for why (nothing like that exists anywhere
// else in this codebase, and the rest of Phase 2 doesn't need it).
@Injectable()
export class PartnerLedgerService {
  constructor(private prisma: PrismaService) {}

  // Called from inside an existing $transaction (pass its `tx` client), never opens
  // its own — mirrors how WalletService.credit()/debit() read-then-write in one callback.
  async postEntry(
    tx: any,
    vendorId: string,
    type: LedgerEntryType,
    amount: number,
    meta?: { orderId?: string; withdrawalRequestId?: string; notes?: string; createdBy?: string },
  ) {
    const last = await tx.partnerLedgerEntry.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });
    const balanceAfter = Number(last?.balanceAfter || 0) + amount;
    return tx.partnerLedgerEntry.create({
      data: {
        vendorId, type, amount, balanceAfter,
        orderId: meta?.orderId, withdrawalRequestId: meta?.withdrawalRequestId,
        notes: meta?.notes, createdBy: meta?.createdBy,
      },
    });
  }

  async ledgerForVendor(vendorId: string, limit = 100) {
    return this.prisma.partnerLedgerEntry.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private async currentBalance(vendorId: string): Promise<number> {
    const last = await this.prisma.partnerLedgerEntry.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });
    return Number(last?.balanceAfter || 0);
  }

  private async pendingWithdrawals(vendorIds: string[]): Promise<number> {
    const agg = await this.prisma.withdrawalRequest.aggregate({
      where: { vendorId: { in: vendorIds }, status: WithdrawalStatus.PENDING },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount || 0);
  }

  /**
   * Available Balance = Total Earned − Already Withdrawn − Pending Withdrawals − Adjustments.
   * Ledger balanceAfter already nets in withdrawals-already-paid and adjustments (they're
   * posted as signed entries) — the one thing NOT yet in the ledger is a still-PENDING
   * withdrawal request, so that's subtracted separately here.
   *
   * For an agency owner this is the "master ledger": sums the owner's own balance plus
   * every team member's balance — members can't withdraw, so their earned-but-locked
   * money pools into what the owner is allowed to pull out.
   */
  async availableBalance(vendorId: string): Promise<number> {
    const vendor = await this.prisma.serviceVendor.findUnique({
      where: { id: vendorId },
      select: { isAgencyOwner: true },
    });
    if (!vendor) throw new NotFoundException('Partner not found');

    if (!vendor.isAgencyOwner) {
      const [balance, pending] = await Promise.all([this.currentBalance(vendorId), this.pendingWithdrawals([vendorId])]);
      return balance - pending;
    }

    const members = await this.prisma.serviceVendor.findMany({ where: { agencyOwnerId: vendorId }, select: { id: true } });
    const allIds = [vendorId, ...members.map((m) => m.id)];
    const balances = await Promise.all(allIds.map((id) => this.currentBalance(id)));
    const totalBalance = balances.reduce((sum, b) => sum + b, 0);
    const pending = await this.pendingWithdrawals(allIds);
    return totalBalance - pending;
  }

  /** Per-member breakdown for the agency owner's "Team Ledger" view. */
  async agencyMemberBalances(agencyOwnerVendorId: string) {
    const members = await this.prisma.serviceVendor.findMany({
      where: { agencyOwnerId: agencyOwnerVendorId },
      select: { id: true, fullName: true, memberStatus: true, rating: true, completedJobs: true },
    });
    return Promise.all(members.map(async (m) => ({
      vendorId: m.id, fullName: m.fullName, memberStatus: m.memberStatus,
      rating: m.rating, completedJobs: m.completedJobs,
      balance: await this.currentBalance(m.id),
    })));
  }
}

@Injectable()
export class WithdrawalService {
  constructor(private prisma: PrismaService, private ledger: PartnerLedgerService) {}

  private async resolveVendor(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    return v;
  }

  async request(userId: string, amount: number) {
    if (!amount || amount <= 0) throw new BadRequestException('Enter a valid withdrawal amount');
    const vendor = await this.resolveVendor(userId);
    // The spec's core rule: team members can never withdraw, only individuals and
    // agency owners (agencyOwnerId null covers both) — enforced here, not just hidden in UI.
    if (vendor.agencyOwnerId) throw new ForbiddenException('Team members cannot request withdrawals — only the agency owner can.');

    const available = await this.ledger.availableBalance(vendor.id);
    if (amount > available) {
      throw new BadRequestException(`Amount exceeds available balance (₹${available.toFixed(2)} available)`);
    }
    return this.prisma.withdrawalRequest.create({
      data: { vendorId: vendor.id, amount, availableBalanceAtRequest: available },
    });
  }

  async myHistory(userId: string, limit = 50) {
    const vendor = await this.resolveVendor(userId);
    return this.prisma.withdrawalRequest.findMany({ where: { vendorId: vendor.id }, orderBy: { createdAt: 'desc' }, take: limit });
  }

  async listAll(status?: WithdrawalStatus, limit = 100) {
    return this.prisma.withdrawalRequest.findMany({
      where: status ? { status } : {},
      include: { vendor: { select: { fullName: true, isAgencyOwner: true, baseCity: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

@ApiTags('Partner Ledger')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('vendors')
export class PartnerLedgerController {
  constructor(private ledger: PartnerLedgerService, private withdrawals: WithdrawalService, private prisma: PrismaService) {}

  @UseGuards(RolesGuard) @Roles(UserRole.SERVICE_VENDOR)
  @Get('ledger/me')
  async myLedger(@CurrentUser() u: JwtPayload) {
    const v = await this.resolveVendorForUser(u.sub);
    return this.ledger.ledgerForVendor(v);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.SERVICE_VENDOR)
  @Get('agency/ledger')
  async agencyLedger(@CurrentUser() u: JwtPayload) {
    const v = await this.resolveVendorForUser(u.sub);
    return this.ledger.agencyMemberBalances(v);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.SERVICE_VENDOR)
  @Post('withdrawals')
  requestWithdrawal(@CurrentUser() u: JwtPayload, @Body() b: { amount: number }) {
    return this.withdrawals.request(u.sub, b.amount);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.SERVICE_VENDOR)
  @Get('withdrawals/me')
  myWithdrawals(@CurrentUser() u: JwtPayload) {
    return this.withdrawals.myHistory(u.sub);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('withdrawals')
  adminListWithdrawals(@Query('status') status?: WithdrawalStatus) {
    return this.withdrawals.listAll(status);
  }

  private async resolveVendorForUser(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    return v.id;
  }
}

@Module({
  controllers: [PartnerLedgerController],
  providers: [PartnerLedgerService, WithdrawalService],
  exports: [PartnerLedgerService, WithdrawalService],
})
export class PartnerLedgerModule {}
