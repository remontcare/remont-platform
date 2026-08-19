import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { LedgerEntryType, WithdrawalStatus, UserRole, PartnerHoldType, PartnerHoldStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, VENDOR_WALLET_TOPUP_MARKER } from '../../common';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';

// Vendor Wallet config — all admin-tunable via the existing SiteSetting key/value screen
// (frontend/admin/settings.html), group 'wallet'. Values below are the fallback defaults
// used only when the row hasn't been seeded yet.
const WALLET_SETTING_DEFAULTS: Record<string, number> = {
  wallet_base_hold_amount: 1000,
  wallet_lead_cost_amount: 50,
  wallet_warranty_days: 7,
  wallet_warranty_hold_percent: 15,
};

// Phase 2 — per-partner ledger + withdrawal requests. Same single-entry-with-
// running-balance idiom as WalletTransaction (wallet.module.ts), just
// vendorId-keyed with a richer category enum. Deliberately NOT a double-entry
// accounting engine — see plan doc for why (nothing like that exists anywhere
// else in this codebase, and the rest of Phase 2 doesn't need it).
@Injectable()
export class PartnerLedgerService {
  constructor(private prisma: PrismaService) {}

  // ── Vendor Wallet config resolvers ──────────────────────────────────────────
  // Same prisma.siteSetting.findUnique + Number() parse pattern already used by
  // admin.module.ts's getSettings(); falls back to WALLET_SETTING_DEFAULTS if the
  // row hasn't been seeded in the admin Settings screen yet.
  private async getSettingNumber(key: string): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : WALLET_SETTING_DEFAULTS[key];
  }

  async getBaseHoldDefault(): Promise<number> {
    return this.getSettingNumber('wallet_base_hold_amount');
  }

  async getLeadCostAmount(): Promise<number> {
    return this.getSettingNumber('wallet_lead_cost_amount');
  }

  /** category may be null/undefined (order's service has no category resolved) — falls
   * straight through to the global defaults in that case. */
  async getWarrantyDefaults(category?: { warrantyDays?: number | null; warrantyHoldPercent?: number | null } | null) {
    const [globalDays, globalPercent] = await Promise.all([
      this.getSettingNumber('wallet_warranty_days'),
      this.getSettingNumber('wallet_warranty_hold_percent'),
    ]);
    return {
      days: category?.warrantyDays ?? globalDays,
      percent: category?.warrantyHoldPercent ?? globalPercent,
    };
  }

  // Called from inside an existing $transaction (pass its `tx` client), never opens
  // its own — mirrors how WalletService.credit()/debit() read-then-write in one callback.
  //
  // Race condition fix: the read-last-balance-then-insert sequence below is a classic
  // lost-update hazard — two concurrent postEntry() calls for the SAME vendor (e.g. a job
  // completion and a withdrawal approval landing at the same instant, or a vendor accepting
  // two different jobs at once) could both read the same "last" balanceAfter under READ
  // COMMITTED before either commits, then both insert a row computed off that same stale
  // balance — corrupting the running total. The SELECT ... FOR UPDATE below takes a
  // row-level lock on the vendor's own ServiceVendor row first, so a second concurrent call
  // for the same vendor blocks until the first transaction commits, guaranteeing "last" is
  // always read fresh. Locking ServiceVendor (one real row per vendor) rather than the
  // ledger's own last row avoids the "which row is 'last'" ambiguity a self-referential lock
  // would have.
  async postEntry(
    tx: any,
    vendorId: string,
    type: LedgerEntryType,
    amount: number,
    meta?: { orderId?: string; withdrawalRequestId?: string; notes?: string; createdBy?: string },
  ) {
    await tx.$queryRaw`SELECT id FROM "ServiceVendor" WHERE id = ${vendorId} FOR UPDATE`;
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

  // ── Vendor Wallet: holds (Warranty Hold + Admin Manual) ─────────────────────
  // Every state change here also posts the matching HOLD/HOLD_RELEASE ledger entry via
  // postEntry() above, so PartnerLedgerEntry stays the single source of truth for balance —
  // PartnerHold only tracks the lifecycle (why money is held, when it's due, who released it).

  async postHold(
    tx: any,
    vendorId: string,
    type: PartnerHoldType,
    amount: number,
    meta?: { orderId?: string; releaseDueAt?: Date; notes?: string; createdBy?: string },
  ) {
    const hold = await tx.partnerHold.create({
      data: {
        vendorId, type, amount, remaining: amount,
        orderId: meta?.orderId, releaseDueAt: meta?.releaseDueAt,
        notes: meta?.notes, createdBy: meta?.createdBy,
      },
    });
    await this.postEntry(tx, vendorId, 'HOLD', -amount, { orderId: meta?.orderId, notes: meta?.notes, createdBy: meta?.createdBy });
    return hold;
  }

  // Race condition fix: a hold can legitimately be touched from two independent paths at
  // once (the daily cron sweep auto-releasing a just-matured hold at the same moment an
  // admin manually releases/forfeits it, or a refund racing either). Reading the hold's
  // status then writing it in two separate statements is a TOCTOU gap — both callers could
  // see status HELD before either commits and both would post a HOLD_RELEASE credit,
  // double-paying the vendor. Every state change below is instead a single conditional
  // updateMany() guarded on status: HELD, exactly like ServiceVendorsService.acceptJob()'s
  // order-claim lock — only the caller whose updateMany() actually matches a row (count===1)
  // proceeds to post the matching ledger entry; the loser is a silent no-op.

  async releaseHold(tx: any, holdId: string, releasedBy?: string) {
    const hold = await tx.partnerHold.findUnique({ where: { id: holdId } });
    if (!hold) throw new NotFoundException('Hold not found');
    const claimed = await tx.partnerHold.updateMany({
      where: { id: holdId, status: PartnerHoldStatus.HELD },
      data: { status: PartnerHoldStatus.RELEASED, remaining: 0, releasedAt: new Date(), releasedBy },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('This hold is not currently active');
    }
    const remaining = Number(hold.remaining);
    if (remaining > 0) {
      await this.postEntry(tx, hold.vendorId, 'HOLD_RELEASE', remaining, { orderId: hold.orderId || undefined, createdBy: releasedBy });
      await tx.serviceVendor.update({ where: { id: hold.vendorId }, data: { pendingPayout: { increment: remaining } } });
    }
    return tx.partnerHold.findUnique({ where: { id: holdId } });
  }

  /** Admin decides the held money never goes back to the vendor — no ledger credit, since
   * the HOLD debit already excluded it from balance; this just closes the lifecycle. */
  async forfeitHold(tx: any, holdId: string, reason?: string) {
    const hold = await tx.partnerHold.findUnique({ where: { id: holdId } });
    if (!hold) throw new NotFoundException('Hold not found');
    const claimed = await tx.partnerHold.updateMany({
      where: { id: holdId, status: PartnerHoldStatus.HELD },
      data: { status: PartnerHoldStatus.FORFEITED, remaining: 0, releasedAt: new Date(), notes: reason || hold.notes },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('This hold is not currently active');
    }
    return tx.partnerHold.findUnique({ where: { id: holdId } });
  }

  /** A refund approved against the held order's job consumes the hold first (capped at
   * what's still held — a refund larger than the remaining hold does not claw back further
   * from the vendor's live balance, that's a separate chargeback concern out of scope here).
   * Guarded on remaining equalling the value just read, so two refunds against the same hold
   * landing at once can never both subtract from the same original `remaining`. */
  async deductFromHold(tx: any, holdId: string, refundAmount: number) {
    const hold = await tx.partnerHold.findUnique({ where: { id: holdId } });
    if (!hold || hold.status !== PartnerHoldStatus.HELD) return null;
    const remaining = Number(hold.remaining);
    const deduction = Math.min(refundAmount, remaining);
    const newRemaining = remaining - deduction;
    const claimed = await tx.partnerHold.updateMany({
      where: { id: holdId, status: PartnerHoldStatus.HELD, remaining: hold.remaining },
      data: {
        remaining: newRemaining,
        ...(newRemaining <= 0 ? { status: PartnerHoldStatus.FORFEITED, releasedAt: new Date(), notes: 'Fully consumed by refund' } : {}),
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('This hold changed concurrently — please retry');
    }
    return tx.partnerHold.findUnique({ where: { id: holdId } });
  }

  // ── Vendor Wallet: Lead Cost ──────────────────────────────────────────────
  // Deducted the instant a vendor accepts a job (see ServiceVendorsService.acceptJob),
  // trued up against the order's remontCommission at completion (see OrdersService.complete).

  async postLeadCost(tx: any, vendorId: string, orderId: string, amount: number) {
    return this.postEntry(tx, vendorId, 'LEAD_COST', -amount, { orderId, notes: 'Lead cost for job acceptance' });
  }

  async refundLeadCost(tx: any, vendorId: string, orderId: string, amount: number) {
    return this.postEntry(tx, vendorId, 'LEAD_COST', amount, { orderId, notes: 'Lead cost refunded on cancellation' });
  }

  async trueUpCommission(tx: any, vendorId: string, orderId: string, remainingCommission: number) {
    if (remainingCommission <= 0) return null;
    return this.postEntry(tx, vendorId, 'COMMISSION', -remainingCommission, { orderId, notes: 'Commission true-up net of lead cost already paid' });
  }

  async ledgerForVendor(vendorId: string, limit = 100) {
    return this.prisma.partnerLedgerEntry.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // Every read below optionally takes a `client` (a $transaction's `tx`, defaulting to the
  // regular `this.prisma` connection) so availableBalance() can be recomputed from inside a
  // transaction that's holding a row lock — see WithdrawalService.request() for why that
  // matters (closes the double-withdrawal-request race).
  private async currentBalance(vendorId: string, client: any = this.prisma): Promise<number> {
    const last = await client.partnerLedgerEntry.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });
    return Number(last?.balanceAfter || 0);
  }

  private async pendingWithdrawals(vendorIds: string[], client: any = this.prisma): Promise<number> {
    const agg = await client.withdrawalRequest.aggregate({
      where: { vendorId: { in: vendorIds }, status: WithdrawalStatus.PENDING },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount || 0);
  }

  /**
   * Available Balance = Total Earned − Already Withdrawn − Pending Withdrawals − Adjustments
   * − Base Hold. Ledger balanceAfter already nets in withdrawals-already-paid and
   * adjustments (they're posted as signed entries) — the one thing NOT yet in the ledger is
   * a still-PENDING withdrawal request, so that's subtracted separately here.
   *
   * Base Hold (Vendor Wallet) is a per-vendor withdrawal floor, not a separate pool of
   * money — it's applied to each vendor's own balance BEFORE pooling, floored at 0, so a
   * member's floor can never be borrowed against by pooling into the owner's withdrawable
   * total (see ServiceVendor.baseHoldAmount).
   *
   * For an agency owner this is the "master ledger": sums the owner's own available balance
   * plus every team member's — members can't withdraw, so their earned-but-locked money
   * pools into what the owner is allowed to pull out.
   */
  private async availableForSingleVendor(vendorId: string, client: any = this.prisma): Promise<number> {
    const vendor = await client.serviceVendor.findUnique({ where: { id: vendorId }, select: { baseHoldAmount: true } });
    const balance = await this.currentBalance(vendorId, client);
    return Math.max(0, balance - Number(vendor?.baseHoldAmount || 0));
  }

  async availableBalance(vendorId: string, client: any = this.prisma): Promise<number> {
    const vendor = await client.serviceVendor.findUnique({
      where: { id: vendorId },
      select: { isAgencyOwner: true },
    });
    if (!vendor) throw new NotFoundException('Partner not found');

    if (!vendor.isAgencyOwner) {
      const [available, pending] = await Promise.all([this.availableForSingleVendor(vendorId, client), this.pendingWithdrawals([vendorId], client)]);
      return Math.max(0, available - pending);
    }

    const members = await client.serviceVendor.findMany({ where: { agencyOwnerId: vendorId }, select: { id: true } });
    const allIds = [vendorId, ...members.map((m: any) => m.id)];
    const availables = await Promise.all(allIds.map((id) => this.availableForSingleVendor(id, client)));
    const totalAvailable = availables.reduce((sum, a) => sum + a, 0);
    const pending = await this.pendingWithdrawals(allIds, client);
    return Math.max(0, totalAvailable - pending);
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

// Vendor Wallet: auto-releases matured Warranty Holds. Same idiom as AmcService's existing
// daily 6 AM cron (amc.module.ts) — runs once a day, sweeps everything due, no per-hold
// scheduling needed since a hold's own releaseDueAt is the only thing that matters.
@Injectable()
export class WarrantyHoldSweepService {
  private readonly logger = new Logger(WarrantyHoldSweepService.name);
  constructor(private prisma: PrismaService, private ledger: PartnerLedgerService) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async sweep() {
    const due = await this.prisma.partnerHold.findMany({
      where: { status: PartnerHoldStatus.HELD, type: PartnerHoldType.WARRANTY_HOLD, releaseDueAt: { lte: new Date() } },
      select: { id: true },
    });
    for (const hold of due) {
      try {
        await this.prisma.$transaction((tx) => this.ledger.releaseHold(tx, hold.id));
      } catch (e) {
        this.logger.error(`Failed to auto-release warranty hold ${hold.id}: ${e.message}`);
      }
    }
    if (due.length) this.logger.log(`Auto-released ${due.length} matured warranty hold(s)`);
  }
}

@Injectable()
export class WithdrawalService {
  constructor(private prisma: PrismaService, private ledger: PartnerLedgerService, private payments: PaymentsService) {}

  private async resolveVendor(userId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    return v;
  }

  // ── Vendor Wallet: Add Money ────────────────────────────────────────────────────────
  // Mirrors WalletService.initiateTopup()/confirmTopup() (wallet.module.ts) exactly — the
  // customer wallet flow is already the proven-safe pattern in this codebase (real
  // Razorpay order, credit only after re-verifying the HMAC signature server-side,
  // idempotent on the PAID check below). The one prior generic "add money" endpoint
  // (WalletService itself) credits User.walletBalance, a completely different balance
  // than the one this portal's Earnings view or the withdrawal system reads
  // (PartnerLedgerEntry/ServiceVendor.pendingPayout) — using it as-is would silently
  // create an orphaned balance a partner would never see. This posts through the real
  // ledger instead, via postEntry(), keeping PartnerLedgerEntry the single source of truth.
  async initiateTopup(userId: string, amount: number, frontendUrl: string) {
    if (!amount || amount <= 0) throw new BadRequestException('Enter a valid amount');
    await this.resolveVendor(userId); // 404s early if this account has no vendor profile
    const payOrder: any = await this.payments.initiatePayment(userId, amount, VENDOR_WALLET_TOPUP_MARKER, frontendUrl);
    // Rename keyId -> razorpayKeyId to match the field name every other frontend Razorpay
    // call site in this codebase already expects (see orders.module.ts's collectBalance()).
    return { ...payOrder, razorpayKeyId: payOrder.keyId };
  }

  // Credits exactly once no matter which caller gets here first — this method itself
  // (the customer's browser calling back after Razorpay's checkout closes) or
  // PaymentsService.handleWebhook's onVendorWalletTopupCaptured listener below (Razorpay's
  // server-to-server webhook, which can legitimately arrive before, after, or concurrently
  // with the browser callback). `status==='PAID'` is NOT used as the "already credited"
  // signal — see the creditedAt field comment in schema.prisma for why that was the bug.
  async confirmTopup(userId: string, paymentId: string, gatewayOrderId: string, signature: string) {
    const vendor = await this.resolveVendor(userId);
    const tx = await this.prisma.paymentTransaction.findFirst({
      where: { gatewayOrderId, userId, orderId: VENDOR_WALLET_TOPUP_MARKER },
    });
    if (!tx) throw new BadRequestException('Top-up payment not found for this account');

    const ok = await this.payments.verifyAndMarkPaid(gatewayOrderId, paymentId, signature);
    if (!ok) throw new BadRequestException('Invalid payment signature');

    await this.claimAndCredit(tx.id, vendor.id, Number(tx.amount));
    return { balance: await this.ledger.availableBalance(vendor.id) };
  }

  /** Atomic claim: only the caller whose updateMany actually flips creditedAt from null
   * wins the right to credit the ledger — the loser (whichever of confirmTopup/the webhook
   * listener arrives second) is a safe no-op. */
  private async claimAndCredit(paymentTransactionId: string, vendorId: string, amount: number) {
    const claimed = await this.prisma.paymentTransaction.updateMany({
      where: { id: paymentTransactionId, creditedAt: null },
      data: { creditedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    await this.prisma.$transaction((txClient) =>
      this.ledger.postEntry(txClient, vendorId, 'TOP_UP', amount, { notes: 'Wallet top-up via Razorpay' }),
    );
  }

  // Safety net for the case where Razorpay's webhook confirms payment before the partner's
  // own browser ever calls confirmTopup() back (tab closed, flaky network, etc.) — without
  // this, that money would be captured by Razorpay but never reach the vendor's ledger.
  @OnEvent('payment.vendorWalletTopup.captured')
  async onVendorWalletTopupCaptured(p: { paymentTransactionId: string; userId: string; amount: number }) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { userId: p.userId } });
    if (!vendor) return;
    await this.claimAndCredit(p.paymentTransactionId, vendor.id, p.amount);
  }

  async request(userId: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Enter a valid withdrawal amount');
    const vendor = await this.resolveVendor(userId);
    // The spec's core rule: team members can never withdraw, only individuals and
    // agency owners (agencyOwnerId null covers both) — enforced here, not just hidden in UI.
    if (vendor.agencyOwnerId) throw new ForbiddenException('Team members cannot request withdrawals — only the agency owner can.');

    // Race condition fix: checking availableBalance() then creating the WithdrawalRequest as
    // two separate statements is a TOCTOU gap — two concurrent requests (a double-tap, or
    // one from the web portal and one from another device) could both read the same
    // available balance before either commits, together requesting more than is actually
    // available. Wrapping in a transaction that first takes a row lock on the vendor's own
    // record (same idiom as PartnerLedgerService.postEntry()'s lock) serializes concurrent
    // requests for the same vendor, so the second one's balance check always sees the
    // first's now-committed pending withdrawal.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ServiceVendor" WHERE id = ${vendor.id} FOR UPDATE`;
      const available = await this.ledger.availableBalance(vendor.id, tx);
      if (amount > available) {
        throw new BadRequestException(`Amount exceeds available balance (₹${available.toFixed(2)} available)`);
      }
      return tx.withdrawalRequest.create({
        data: { vendorId: vendor.id, amount, availableBalanceAtRequest: available },
      });
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
  @Post('wallet/topup')
  walletTopup(@CurrentUser() u: JwtPayload, @Body() b: { amount: number }) {
    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    return this.withdrawals.initiateTopup(u.sub, b.amount, frontendUrl);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.SERVICE_VENDOR)
  @Post('wallet/topup/confirm')
  confirmWalletTopup(@CurrentUser() u: JwtPayload, @Body() b: { gatewayOrderId: string; paymentId: string; signature: string }) {
    return this.withdrawals.confirmTopup(u.sub, b.paymentId, b.gatewayOrderId, b.signature);
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
  imports: [PaymentsModule],
  controllers: [PartnerLedgerController],
  providers: [PartnerLedgerService, WithdrawalService, WarrantyHoldSweepService],
  exports: [PartnerLedgerService, WithdrawalService],
})
export class PartnerLedgerModule {}
