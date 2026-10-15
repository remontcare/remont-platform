import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards, Logger,
  BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RefundDecisionMode, RefundRequestStatus, ProviderRefundStatus, UserRole } from '@prisma/client';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, logAudit } from '../../common';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { WalletService, WalletModule } from '../wallet/wallet.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';
import { InvoicesService, InvoicesModule } from '../invoices/invoices.module';

// Business rule (highest priority, per product): a refund is NEVER automatic, even for an
// online payment. Full pipeline: customer raises a request -> evidence -> partner response
// -> admin review -> final decision by ADMIN/SUPER_ADMIN only -> processed. Default decision
// is Wallet Credit; gateway refund back to the original payment method is the exception path.
const ACTIVE_STATUSES: RefundRequestStatus[] = ['REQUESTED', 'PARTNER_RESPONDED', 'UNDER_REVIEW', 'ESCALATED'];
const MONEY_MODES: RefundDecisionMode[] = ['WALLET_CREDIT', 'GATEWAY_REFUND', 'PARTIAL_WALLET_PARTIAL_GATEWAY'];
const NON_MONEY_MODES: RefundDecisionMode[] = ['NO_REFUND', 'FREE_REWORK', 'DISCOUNT_COUPON'];
// Decided, money not (yet) confirmed moved — the reservation stays until a final outcome.
const IN_FLIGHT_STATUSES: RefundRequestStatus[] = ['PROCESSING', 'REFUND_PENDING', 'NEEDS_ATTENTION'];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** What a refund request holds against its booking's refundable limit. Requests decided before
 * reservations existed count their processed amount. */
const committedOf = (r: { status: string; claimedAmount: any; approvedAmount: any; walletCreditAmount: any; gatewayRefundAmount: any }) =>
  Number(r.claimedAmount || 0) > 0
    ? Number(r.claimedAmount)
    : r.status === 'PROCESSED' ? Number(r.approvedAmount ?? Number(r.walletCreditAmount || 0) + Number(r.gatewayRefundAmount || 0)) : 0;

/** The booking cannot refund this much — thrown before any money moves. */
export class RefundCapacityExceeded extends BadRequestException {}

interface DecideOptions {
  approvedAmount?: number;
  walletCreditAmount?: number;
  gatewayRefundAmount?: number;
  adminNotes?: string;
}

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  constructor(
    private prisma: PrismaService, private payments: PaymentsService, private wallet: WalletService,
    private paymentNotify: PaymentNotificationsService, private ledger: PartnerLedgerService,
    private invoices: InvoicesService,
  ) {}

  private log(refundRequestId: string, actorId: string | undefined, actorRole: UserRole | undefined, action: string, notes?: string) {
    return this.prisma.refundRequestLog.create({ data: { refundRequestId, actorId, actorRole, action, notes } });
  }

  async raise(
    customerId: string, orderId: string | undefined, masterOrderId: string | undefined, reason: string, evidenceUrls: string[],
    opts?: { allowWalletPortion?: boolean; supportCaseId?: string },
  ) {
    if (!orderId && !masterOrderId) throw new BadRequestException('orderId or masterOrderId is required');
    if (!reason?.trim()) throw new BadRequestException('A reason is required');

    let partnerId: string | undefined;
    if (orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.customerId !== customerId) throw new ForbiddenException();
      // allowWalletPortion (support-case cancellations only): an unpaid cash-on-service order
      // can still have wallet money applied to it, and that portion is refundable.
      const walletPortion = !!opts?.allowWalletPortion && Number(order.walletUsed || 0) > 0;
      if (!['PAID', 'PARTIAL'].includes(order.paymentStatus) && !walletPortion) throw new BadRequestException('This order has no payment to refund');
      partnerId = order.vendorId || undefined;
    } else {
      const mo = await this.prisma.masterOrder.findUnique({ where: { id: masterOrderId! } });
      if (!mo) throw new NotFoundException('Order not found');
      if (mo.customerId !== customerId) throw new ForbiddenException();
      if (!['PAID', 'PARTIAL'].includes(mo.paymentStatus)) throw new BadRequestException('This order has no payment to refund');
    }

    const rr = await this.prisma.refundRequest.create({
      data: { orderId, masterOrderId, customerId, reason, evidenceUrls: evidenceUrls || [], partnerId, status: 'REQUESTED', ...(opts?.supportCaseId ? { supportCaseId: opts.supportCaseId } : {}) },
    });
    await this.log(rr.id, customerId, UserRole.CUSTOMER, 'REQUESTED', reason);
    return rr;
  }

  async partnerRespond(vendorUserId: string, refundRequestId: string, response: string) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id: refundRequestId } });
    if (!rr) throw new NotFoundException();
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v || rr.partnerId !== v.id) throw new ForbiddenException();
    if (rr.status !== 'REQUESTED') throw new BadRequestException('This request is no longer awaiting a partner response');

    const updated = await this.prisma.refundRequest.update({
      where: { id: refundRequestId },
      data: { status: 'PARTNER_RESPONDED', partnerResponse: response, partnerRespondedAt: new Date() },
    });
    await this.log(refundRequestId, vendorUserId, UserRole.SERVICE_VENDOR, 'PARTNER_RESPONDED', response);
    return updated;
  }

  async listForCustomer(customerId: string) {
    return this.prisma.refundRequest.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } });
  }

  async listForPartner(vendorUserId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    return this.prisma.refundRequest.findMany({ where: { partnerId: v.id }, orderBy: { createdAt: 'desc' } });
  }

  async listForAdmin(status?: RefundRequestStatus) {
    const requests = await this.prisma.refundRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { providerRefund: { select: { id: true, status: true, providerRefundId: true, attempts: true, lastError: true, lastCheckedAt: true, gateway: true } } },
    });
    // customerId/orderId/masterOrderId/partnerId are loose, non-FK strings (same convention
    // as PaymentTransaction) — resolve display names with a few batched lookups instead of
    // leaving the admin screen to show raw ids.
    const customerIds = [...new Set(requests.map((r) => r.customerId))];
    const orderIds = [...new Set(requests.map((r) => r.orderId).filter(Boolean))] as string[];
    const masterOrderIds = [...new Set(requests.map((r) => r.masterOrderId).filter(Boolean))] as string[];
    const partnerIds = [...new Set(requests.map((r) => r.partnerId).filter(Boolean))] as string[];

    const [customers, orders, masterOrders, partners]: [
      { id: string; name: string; phone: string }[],
      { id: string; orderNumber: string; totalAmount: any }[],
      { id: string; masterOrderNumber: string; totalAmount: any }[],
      { id: string; fullName: string }[],
    ] = await Promise.all([
      customerIds.length ? this.prisma.user.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true } }) : [],
      orderIds.length ? this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, totalAmount: true } }) : [],
      masterOrderIds.length ? this.prisma.masterOrder.findMany({ where: { id: { in: masterOrderIds } }, select: { id: true, masterOrderNumber: true, totalAmount: true } }) : [],
      partnerIds.length ? this.prisma.serviceVendor.findMany({ where: { id: { in: partnerIds } }, select: { id: true, fullName: true } }) : [],
    ]);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const masterOrderById = new Map(masterOrders.map((m) => [m.id, m]));
    const partnerById = new Map(partners.map((p) => [p.id, p]));

    return requests.map((r) => {
      const order = r.orderId ? orderById.get(r.orderId) : undefined;
      const masterOrder = r.masterOrderId ? masterOrderById.get(r.masterOrderId) : undefined;
      return {
        ...r,
        customerName: customerById.get(r.customerId)?.name,
        customerPhone: customerById.get(r.customerId)?.phone,
        orderNumber: order?.orderNumber ?? masterOrder?.masterOrderNumber,
        orderTotalAmount: order?.totalAmount ?? masterOrder?.totalAmount,
        partnerName: r.partnerId ? partnerById.get(r.partnerId)?.fullName : undefined,
      };
    });
  }

  async getDetail(id: string, actorUserId: string, actorRole: UserRole) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } }, providerRefund: true } });
    if (!rr) throw new NotFoundException();
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    if (adminRoles.includes(actorRole) || rr.customerId === actorUserId) return rr;
    if (actorRole === UserRole.SERVICE_VENDOR) {
      const v = await this.prisma.serviceVendor.findUnique({ where: { userId: actorUserId } });
      if (v && rr.partnerId === v.id) return rr;
    }
    throw new ForbiddenException();
  }

  private async getActiveRequest(id: string) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id } });
    if (!rr) throw new NotFoundException();
    if (!ACTIVE_STATUSES.includes(rr.status)) throw new BadRequestException('This refund request has already been decided');
    return rr;
  }

  async markUnderReview(adminId: string, refundRequestId: string, notes?: string) {
    await this.getActiveRequest(refundRequestId);
    const updated = await this.prisma.refundRequest.update({ where: { id: refundRequestId }, data: { status: 'UNDER_REVIEW' } });
    await this.log(refundRequestId, adminId, UserRole.ADMIN, 'UNDER_REVIEW', notes);
    return updated;
  }

  async escalate(adminId: string, refundRequestId: string, notes: string) {
    await this.getActiveRequest(refundRequestId);
    const updated = await this.prisma.refundRequest.update({ where: { id: refundRequestId }, data: { status: 'ESCALATED' } });
    await this.log(refundRequestId, adminId, UserRole.ADMIN, 'ESCALATED', notes);
    return updated;
  }

  private async findRefundableTransaction(client: any, orderId: string | null, masterOrderId: string | null, amount: number) {
    const tx = await client.paymentTransaction.findFirst({
      where: {
        OR: [orderId ? { orderId } : undefined, masterOrderId ? { masterOrderId } : undefined].filter(Boolean) as any,
        status: 'PAID',
        gateway: { in: ['RAZORPAY', 'PHONEPE'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!tx) throw new BadRequestException('No online gateway payment found for this order — use Wallet Credit instead');
    if (amount > Number(tx.amount)) throw new BadRequestException('Refund amount exceeds the original gateway payment');
    return tx;
  }

  // ─── Booking-level refund safety boundary (shared by EVERY refund route) ───────────────

  /** Gateway/cash money actually received for an order or master order (captured payments; a
   * child of a paid master order, or a collected cash booking, counts its own total once PAID). */
  private async gatewayOrCashReceived(client: any, p: { orderId?: string; masterOrderId?: string; paymentStatus?: string | null; totalAmount: any }) {
    const txs = await client.paymentTransaction.findMany({
      where: {
        status: 'PAID', isWalletTopup: false, refundRequestId: null,
        ...(p.orderId ? { orderId: p.orderId } : { OR: [{ masterOrderId: p.masterOrderId }, { orderId: p.masterOrderId }] }),
      },
      select: { amount: true },
    });
    if (txs.length) return r2(txs.reduce((sum: number, t: any) => sum + Number(t.amount || 0), 0));
    return ['PAID', 'REFUNDED'].includes(String(p.paymentStatus)) ? Number(p.totalAmount || 0) : 0;
  }

  /**
   * What a booking can still refund: money actually received (captured gateway/cash payment +
   * wallet used) minus everything committed against it by ANY route — completed refunds and
   * outstanding claims (in progress, pending at the provider, or needing attention). A refund
   * on the whole master order and refunds on its child bookings share one limit.
   */
  async bookingRefundState(client: any, scope: { orderId?: string | null; masterOrderId?: string | null }, excludeRefundRequestId?: string) {
    let received = 0;
    let where: any[];
    if (scope.orderId) {
      const order = await client.order.findUnique({ where: { id: scope.orderId }, select: { id: true, masterOrderId: true, paymentStatus: true, totalAmount: true, walletUsed: true } });
      if (!order) throw new NotFoundException('Order not found');
      received = (await this.gatewayOrCashReceived(client, { orderId: order.id, paymentStatus: order.paymentStatus, totalAmount: order.totalAmount })) + Number(order.walletUsed || 0);
      where = [{ orderId: order.id }, ...(order.masterOrderId ? [{ masterOrderId: order.masterOrderId, orderId: null }] : [])];
    } else if (scope.masterOrderId) {
      const mo = await client.masterOrder.findUnique({ where: { id: scope.masterOrderId }, select: { id: true, paymentStatus: true, totalAmount: true, walletUsed: true, childOrders: { select: { id: true } } } });
      if (!mo) throw new NotFoundException('Order not found');
      received = (await this.gatewayOrCashReceived(client, { masterOrderId: mo.id, paymentStatus: mo.paymentStatus, totalAmount: mo.totalAmount })) + Number(mo.walletUsed || 0);
      const childIds = (mo.childOrders || []).map((c: any) => c.id);
      where = [{ masterOrderId: mo.id, orderId: null }, ...(childIds.length ? [{ orderId: { in: childIds } }] : [])];
    } else {
      throw new BadRequestException('orderId or masterOrderId is required');
    }
    const rows = await client.refundRequest.findMany({
      where: { OR: where },
      select: { id: true, status: true, claimedAmount: true, approvedAmount: true, walletCreditAmount: true, gatewayRefundAmount: true },
    });
    let committed = 0;
    let inFlight = 0;
    for (const r of rows) {
      if (r.id === excludeRefundRequestId) continue;
      const c = committedOf(r);
      committed += c;
      if (IN_FLIGHT_STATUSES.includes(r.status)) inFlight += c;
    }
    received = r2(received);
    committed = r2(committed);
    return { received, committed, inFlight: r2(inFlight), refundable: r2(Math.max(0, received - committed)) };
  }

  /** Lock key covering a booking AND its master order, so every refund on either is serialised. */
  private async bookingLockKey(orderId: string | null, masterOrderId: string | null) {
    if (orderId) {
      const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { masterOrderId: true } });
      return 'refund-booking:' + (o?.masterOrderId || orderId);
    }
    return 'refund-booking:' + masterOrderId;
  }

  /** Wallet credit for a refund request at most once: the RefundWalletCredit guard row (unique per
   * request) and the credit itself are ONE transaction — two racing retries can never both credit,
   * and a failed credit leaves no guard behind. Credits made before this release are found directly. */
  private async creditWalletOnce(customerId: string, amount: number, orderId: string | undefined, notes: string, refundRequestId: string, adminId: string) {
    const already = await this.prisma.walletTransaction.findFirst({ where: { refundRequestId, type: 'CREDIT' }, select: { id: true } });
    if (already) return already;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.refundWalletCredit.create({ data: { refundRequestId } });
        const wt = await this.wallet.credit(customerId, amount, 'REFUND' as any, orderId, notes, refundRequestId, adminId, tx);
        await tx.refundWalletCredit.update({ where: { refundRequestId }, data: { walletTransactionId: wt.id } });
        return wt;
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return this.prisma.walletTransaction.findFirst({ where: { refundRequestId, type: 'CREDIT' }, select: { id: true } });
      throw e;
    }
  }

  /**
   * The only place money (or a wallet credit) moves for a refund — reachable by ADMIN/SUPER_ADMIN
   * (controller RolesGuard) and the internal admin-approved pipelines (support cases, returns,
   * warranty, seller rejection). Steps: (1) under the BOOKING lock, in ONE transaction, the request
   * is claimed and its amount reserved against what the booking can still refund — so no two
   * routes can over-refund; (2) the wallet leg is posted at most once; (3) the gateway leg is one
   * provider refund with a stable id + idempotency key, whose outcome drives the request's status.
   * A refund is "completed" only when its money actually moved (wallet) or the provider confirmed it.
   * No partner recovery happens here — that is always a separate, explicit admin decision.
   */
  async decide(adminId: string, refundRequestId: string, decisionMode: RefundDecisionMode, opts: DecideOptions) {
    if (![...NON_MONEY_MODES, ...MONEY_MODES].includes(decisionMode)) throw new BadRequestException('Unknown decision mode');
    const moves = MONEY_MODES.includes(decisionMode);
    const head = await this.prisma.refundRequest.findUnique({ where: { id: refundRequestId }, select: { orderId: true, masterOrderId: true } });
    if (!head) throw new NotFoundException();
    const lockKey = await this.bookingLockKey(head.orderId, head.masterOrderId);

    // (1) claim + reserve under the booking lock — the claim is persisted before the lock is released
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const rr = await tx.refundRequest.findUnique({ where: { id: refundRequestId } });
      if (!rr || !ACTIVE_STATUSES.includes(rr.status)) throw new BadRequestException('This refund request has already been decided');
      let wallet = 0;
      let gateway = 0;
      if (moves) {
        const owner = rr.orderId
          ? await tx.order.findUnique({ where: { id: rr.orderId }, select: { totalAmount: true } })
          : await tx.masterOrder.findUnique({ where: { id: rr.masterOrderId! }, select: { totalAmount: true } });
        const total = Number(owner?.totalAmount ?? 0);
        if (decisionMode === 'WALLET_CREDIT') wallet = r2(opts.approvedAmount ?? total);
        else if (decisionMode === 'GATEWAY_REFUND') gateway = r2(opts.approvedAmount ?? total);
        else {
          wallet = r2(opts.walletCreditAmount ?? 0);
          gateway = r2(opts.gatewayRefundAmount ?? 0);
          if (wallet <= 0 && gateway <= 0) throw new BadRequestException('Specify walletCreditAmount and/or gatewayRefundAmount');
        }
        if (wallet < 0 || gateway < 0 || wallet + gateway <= 0) throw new BadRequestException('approvedAmount must be greater than zero');
        if (gateway > 0) await this.findRefundableTransaction(tx, rr.orderId, rr.masterOrderId, gateway);
        const state = await this.bookingRefundState(tx, { orderId: rr.orderId, masterOrderId: rr.masterOrderId }, rr.id);
        if (r2(wallet + gateway) > state.refundable) {
          throw new RefundCapacityExceeded(`This refund (₹${r2(wallet + gateway)}) exceeds the ₹${state.refundable} still refundable for this booking (received ₹${state.received}, already refunded or in progress ₹${state.committed})`);
        }
      }
      const newStatus: RefundRequestStatus = !moves ? (decisionMode === 'NO_REFUND' ? 'REJECTED' : 'APPROVED') : 'PROCESSING';
      const total = r2(wallet + gateway);
      const c = await tx.refundRequest.updateMany({
        where: { id: refundRequestId, status: { in: ACTIVE_STATUSES } },
        data: {
          status: newStatus, decisionMode, claimedAmount: total,
          approvedAmount: moves ? total : (opts.approvedAmount || 0),
          walletCreditAmount: wallet || undefined, gatewayRefundAmount: gateway || undefined,
          adminNotes: opts.adminNotes, approvedBy: adminId, approvedAt: new Date(),
        },
      });
      if (c.count !== 1) throw new BadRequestException('This refund request has already been decided');
      return { rr, wallet, gateway, newStatus };
    }, { timeout: 15000, maxWait: 10000 });

    await this.log(refundRequestId, adminId, UserRole.ADMIN, `DECIDED:${decisionMode}`, opts.adminNotes);
    if (!moves) {
      await this.notifyCustomer(claim.rr, claim.newStatus === 'REJECTED' ? 'rejected' : 'approved', decisionMode, Number(opts.approvedAmount || 0));
      return this.prisma.refundRequest.findUniqueOrThrow({ where: { id: refundRequestId } });
    }

    // (2) wallet leg — a single DB transaction behind a unique constraint: it either posted once or not at all
    if (claim.wallet > 0) {
      try {
        await this.creditWalletOnce(claim.rr.customerId, claim.wallet, claim.rr.orderId ?? undefined, opts.adminNotes || 'Refund approved', refundRequestId, adminId);
      } catch (e) {
        // Nothing was credited (the wallet leg runs first, before any gateway call) — release the
        // reservation and reopen the request so it can be decided again.
        await this.prisma.refundRequest.updateMany({ where: { id: refundRequestId, status: 'PROCESSING' }, data: { status: 'UNDER_REVIEW', claimedAmount: 0 } });
        await this.log(refundRequestId, adminId, UserRole.ADMIN, 'WALLET_CREDIT_FAILED', (e as Error).message);
        throw e;
      }
    }

    // (3) gateway leg — or complete a wallet-only refund
    if (claim.gateway > 0) {
      await this.runGatewayLeg(claim.rr, claim.gateway, adminId);
    } else {
      const won = await this.prisma.refundRequest.updateMany({ where: { id: refundRequestId, status: 'PROCESSING' }, data: { status: 'PROCESSED' } });
      if (won.count === 1) await this.finalizeProcessed(refundRequestId, adminId);
    }
    return this.prisma.refundRequest.findUniqueOrThrow({ where: { id: refundRequestId }, include: { providerRefund: true } });
  }

  /** One provider refund per request — created once, then every attempt reuses its key and amount. */
  private async runGatewayLeg(rr: { id: string; orderId: string | null; masterOrderId: string | null }, gatewayAmount: number, actorId: string) {
    const pt = await this.findRefundableTransaction(this.prisma, rr.orderId, rr.masterOrderId, gatewayAmount);
    const amountPaise = Math.round(gatewayAmount * 100);
    let pr = await this.prisma.providerRefund.findUnique({ where: { refundRequestId: rr.id } });
    if (!pr) {
      pr = await this.prisma.providerRefund.create({
        data: {
          refundRequestId: rr.id, paymentTransactionId: pt.id, gateway: pt.gateway,
          gatewayPaymentId: (pt.gateway === 'PHONEPE' ? pt.gatewayOrderId : pt.gatewayPaymentId) || '',
          amountPaise, idempotencyKey: `rfnd_${rr.id}`,
        },
      }).catch(async (e: any) => {
        if (e?.code === 'P2002') return this.prisma.providerRefund.findUnique({ where: { refundRequestId: rr.id } });
        throw e;
      });
    }
    if (!pr) throw new NotFoundException('Provider refund record missing');
    if (pr.amountPaise !== amountPaise) {
      // never send a different amount under an existing key
      return this.applyProviderOutcome(pr.id, { unknown: true, error: `Amount mismatch: stored ${pr.amountPaise} paise, requested ${amountPaise}` }, actorId);
    }
    return this.submitProviderRefund(pr, actorId);
  }

  /** Sends (or re-sends, with the SAME key and amount) the provider refund and applies the outcome. */
  private async submitProviderRefund(pr: { id: string; refundRequestId: string; gateway: string; gatewayPaymentId: string; amountPaise: number; idempotencyKey: string }, actorId: string) {
    await this.prisma.providerRefund.update({ where: { id: pr.id }, data: { attempts: { increment: 1 }, lastCheckedAt: new Date() } });
    if (pr.gateway === 'RAZORPAY') {
      const res = await this.payments.createRazorpayRefund(
        pr.gatewayPaymentId, pr.amountPaise, pr.idempotencyKey, pr.id, { internal_refund_id: pr.id, refund_request_id: pr.refundRequestId },
      );
      if (res.ok) {
        if (res.refund.amount != null && res.refund.amount !== pr.amountPaise) {
          return this.applyProviderOutcome(pr.id, { providerRefundId: res.refund.id, unknown: true, error: `Provider amount ${res.refund.amount} ≠ ${pr.amountPaise}` }, actorId);
        }
        return this.applyProviderOutcome(pr.id, { providerRefundId: res.refund.id, providerStatus: res.refund.status }, actorId);
      }
      if (res.kind === 'DEFINITE_REJECTION') return this.applyProviderOutcome(pr.id, { definiteFailure: true, error: res.message }, actorId);
      return this.applyProviderOutcome(pr.id, { unknown: true, error: `${res.kind}: ${res.message}` }, actorId);
    }
    if (pr.gateway === 'PHONEPE') {
      try {
        await this.payments.submitPhonePeRefund(pr.gatewayPaymentId, pr.amountPaise / 100, pr.id);
        // Accepted is not completed — PhonePe has no status check wired here; an admin confirms.
        return this.applyProviderOutcome(pr.id, { providerRefundId: pr.id, providerStatus: 'pending' }, actorId);
      } catch (e) {
        return this.applyProviderOutcome(pr.id, { unknown: true, error: (e as Error).message }, actorId);
      }
    }
    return this.applyProviderOutcome(pr.id, { definiteFailure: true, error: `Unsupported gateway ${pr.gateway}` }, actorId);
  }

  /**
   * The ONE state machine for a provider refund (decision, retry, webhook, reconciliation all go
   * through here). Monotonic: PROCESSED and FAILED are final and never change; UNKNOWN never
   * overwrites PENDING. PROCESSED completes the request (finalised exactly once); FAILED releases
   * the gateway part of the reservation (and of a support case's claim) in the same transaction;
   * PENDING / UNKNOWN keep the reservation.
   */
  private async applyProviderOutcome(
    providerRefundRowId: string,
    o: { providerRefundId?: string; providerStatus?: string; definiteFailure?: boolean; unknown?: boolean; error?: string },
    actorId: string,
  ) {
    const target: ProviderRefundStatus = o.definiteFailure ? 'FAILED'
      : o.unknown ? 'UNKNOWN'
        : o.providerStatus === 'processed' ? 'PROCESSED'
          : o.providerStatus === 'failed' ? 'FAILED'
            : 'PENDING';
    const result = await this.prisma.$transaction(async (tx) => {
      const pr = await tx.providerRefund.findUnique({ where: { id: providerRefundRowId } });
      if (!pr) throw new NotFoundException('Provider refund not found');
      if (pr.status === 'PROCESSED' || pr.status === 'FAILED') return { changed: false, pr, target: pr.status, conflict: pr.status !== target };
      if (target === 'UNKNOWN' && pr.status === 'PENDING') {
        await tx.providerRefund.update({ where: { id: pr.id }, data: { lastError: o.error, lastCheckedAt: new Date() } });
        return { changed: false, pr, target: pr.status, conflict: false };
      }
      const moved = await tx.providerRefund.updateMany({
        where: { id: pr.id, status: { in: ['CREATED', 'PENDING', 'UNKNOWN'] } },
        data: {
          status: target,
          ...(o.providerRefundId ? { providerRefundId: o.providerRefundId } : {}),
          ...(o.providerStatus ? { providerStatus: o.providerStatus } : {}),
          lastError: o.error ?? null, lastCheckedAt: new Date(),
          ...(target === 'PROCESSED' ? { processedAt: new Date() } : {}),
          ...(target === 'FAILED' ? { failedAt: new Date() } : {}),
        },
      });
      if (moved.count !== 1) return { changed: false, pr, target, conflict: false };
      const amount = pr.amountPaise / 100;
      if (target === 'PROCESSED') {
        const won = await tx.refundRequest.updateMany({
          where: { id: pr.refundRequestId, status: { in: ['PROCESSING', 'REFUND_PENDING', 'NEEDS_ATTENTION'] } },
          data: { status: 'PROCESSED', gatewayRefundId: o.providerRefundId ?? pr.providerRefundId ?? undefined },
        });
        return { changed: true, pr, target, finalize: won.count === 1 };
      }
      if (target === 'FAILED') {
        const rr = await tx.refundRequest.findUnique({ where: { id: pr.refundRequestId }, select: { claimedAmount: true, supportCaseId: true } });
        await tx.refundRequest.update({
          where: { id: pr.refundRequestId },
          data: { status: 'REFUND_FAILED', claimedAmount: r2(Math.max(0, Number(rr?.claimedAmount || 0) - amount)) },
        });
        if (rr?.supportCaseId) {
          const kase = await tx.supportCase.findUnique({ where: { id: rr.supportCaseId }, select: { refundedTotal: true } });
          if (kase) await tx.supportCase.update({ where: { id: rr.supportCaseId }, data: { refundedTotal: r2(Math.max(0, Number(kase.refundedTotal || 0) - amount)) } });
        }
        return { changed: true, pr, target };
      }
      await tx.refundRequest.updateMany({
        where: { id: pr.refundRequestId, status: { in: target === 'PENDING' ? ['PROCESSING', 'NEEDS_ATTENTION'] : ['PROCESSING'] } },
        data: { status: target === 'PENDING' ? 'REFUND_PENDING' : 'NEEDS_ATTENTION' },
      });
      return { changed: true, pr, target };
    }, { timeout: 15000, maxWait: 10000 });

    const rrId = result.pr.refundRequestId;
    if (result.changed) {
      await this.log(rrId, actorId === 'WEBHOOK' ? undefined : actorId, actorId === 'WEBHOOK' ? undefined : UserRole.ADMIN, `PROVIDER_${result.target}`,
        [o.providerRefundId && `ref ${o.providerRefundId}`, o.providerStatus && `provider status ${o.providerStatus}`, o.error].filter(Boolean).join(' · ') || undefined);
    } else if ((result as any).conflict) {
      await this.log(rrId, undefined, undefined, 'PROVIDER_EVENT_IGNORED', `Already ${result.pr.status}; ignored a later "${o.providerStatus ?? (o.unknown ? 'unknown' : '')}" outcome`);
    }
    if ((result as any).finalize) await this.finalizeProcessed(rrId, actorId);
    const rr = await this.prisma.refundRequest.findUnique({ where: { id: rrId }, select: { status: true } });
    return rr?.status;
  }

  /** Side effects of a COMPLETED refund (money actually moved) — run exactly once. */
  private async finalizeProcessed(refundRequestId: string, actorId: string) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id: refundRequestId } });
    if (!rr) return;
    const amount = Number(rr.approvedAmount || 0);
    const order = rr.orderId ? await this.prisma.order.findUnique({ where: { id: rr.orderId } }) : null;
    const masterOrder = rr.masterOrderId ? await this.prisma.masterOrder.findUnique({ where: { id: rr.masterOrderId } }) : null;
    // Phase 6 (C-06) — a credit note against an already-issued invoice; best-effort.
    if (rr.orderId && amount > 0) {
      await this.invoices.issueCreditNote(rr.orderId, refundRequestId, amount, rr.adminNotes || `Refund — ${rr.decisionMode}`)
        .catch((e) => this.logger.error(`Credit note issuance failed for order ${rr.orderId}: ${e.message}`));
    }
    const totalAmount = Number(order?.totalAmount ?? masterOrder?.totalAmount ?? 0);
    if (totalAmount > 0 && amount >= totalAmount) {
      // An unpaid order (only its wallet portion refunded) is never flagged as REFUNDED.
      const unpaidOrder = !!order?.paymentStatus && !['PAID', 'PARTIAL'].includes(order.paymentStatus);
      if (order && !unpaidOrder) await this.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'REFUNDED' } });
      if (masterOrder) await this.prisma.masterOrder.update({ where: { id: masterOrder.id }, data: { paymentStatus: 'REFUNDED' } });
    }
    await this.notifyCustomer(rr, 'approved', rr.decisionMode as RefundDecisionMode, amount, order?.orderNumber ?? masterOrder?.masterOrderNumber);
  }

  private async notifyCustomer(rr: { customerId: string; orderId: string | null; masterOrderId: string | null }, label: string, mode: RefundDecisionMode, amount: number, orderNumber?: string) {
    let num = orderNumber;
    if (!num && rr.orderId) num = (await this.prisma.order.findUnique({ where: { id: rr.orderId }, select: { orderNumber: true } }))?.orderNumber;
    if (!num && rr.masterOrderId) num = (await this.prisma.masterOrder.findUnique({ where: { id: rr.masterOrderId }, select: { masterOrderNumber: true } }))?.masterOrderNumber;
    if (!num) return;
    const user = await this.prisma.user.findUnique({ where: { id: rr.customerId }, select: { phone: true } });
    if (user?.phone) this.paymentNotify.refundProcessed(rr.customerId, user.phone, num, amount, label, mode, rr.orderId ?? undefined).catch(() => {});
  }

  /** Razorpay webhook (signature-verified + de-duplicated by event id in PaymentsService). */
  @OnEvent('provider.refund.update')
  async onProviderRefundUpdate(e: { gateway: string; event: string; refundId: string; paymentId?: string; status?: string; amount?: number; receipt?: string; internalRefundId?: string }) {
    const ids = [e.receipt, e.internalRefundId].filter(Boolean) as string[];
    const pr = await this.prisma.providerRefund.findFirst({ where: { OR: [{ providerRefundId: e.refundId }, ...(ids.length ? [{ id: { in: ids } }] : [])] } });
    if (!pr) { this.logger.warn(`Refund webhook for unknown refund ${e.refundId} — not created by this workflow`); return; }
    if (pr.providerRefundId && pr.providerRefundId !== e.refundId) {
      await this.log(pr.refundRequestId, undefined, undefined, 'PROVIDER_EVENT_IGNORED', `Event for ${e.refundId} does not match ${pr.providerRefundId}`);
      return;
    }
    if (e.amount != null && e.amount !== pr.amountPaise) {
      await this.applyProviderOutcome(pr.id, { providerRefundId: e.refundId, unknown: true, error: `Webhook amount ${e.amount} ≠ ${pr.amountPaise}` }, 'WEBHOOK');
      return;
    }
    const status = e.event === 'refund.processed' ? 'processed' : e.event === 'refund.failed' ? 'failed' : (e.status || 'pending');
    await this.applyProviderOutcome(pr.id, { providerRefundId: e.refundId, providerStatus: status }, 'WEBHOOK');
  }

  /**
   * Admin "Check with Razorpay": settles an uncertain gateway refund without ever risking a second
   * one — fetch it by its provider id, else find it by our stable receipt; if Razorpay has no such
   * refund, re-send with the SAME idempotency key and amount (Razorpay returns the original if it
   * exists). A reservation is never released here except on a provider-confirmed failure.
   */
  async reconcileProviderRefund(adminId: string, refundRequestId: string) {
    const pr = await this.prisma.providerRefund.findUnique({ where: { refundRequestId } });
    if (!pr) throw new BadRequestException('This refund has no gateway part to reconcile');
    if (pr.status === 'PROCESSED' || pr.status === 'FAILED') return this.prisma.refundRequest.findUnique({ where: { id: refundRequestId }, include: { providerRefund: true } });
    if (pr.gateway !== 'RAZORPAY') throw new BadRequestException(`${pr.gateway} refunds cannot be checked automatically — verify in the ${pr.gateway} dashboard and record the confirmed outcome`);
    let found: { id: string; status: string; amount: number } | null;
    try {
      found = pr.providerRefundId
        ? await this.payments.fetchRazorpayRefund(pr.gatewayPaymentId, pr.providerRefundId)
        : await this.payments.findRazorpayRefundByReceipt(pr.gatewayPaymentId, pr.id);
    } catch (e) {
      await this.prisma.providerRefund.update({ where: { id: pr.id }, data: { lastError: `Status check failed: ${(e as Error).message}`, lastCheckedAt: new Date() } });
      throw new BadRequestException(`Could not reach Razorpay — nothing changed. ${(e as Error).message}`);
    }
    if (found) {
      if (found.amount !== pr.amountPaise) await this.applyProviderOutcome(pr.id, { providerRefundId: found.id, unknown: true, error: `Provider amount ${found.amount} ≠ ${pr.amountPaise}` }, adminId);
      else await this.applyProviderOutcome(pr.id, { providerRefundId: found.id, providerStatus: found.status }, adminId);
    } else if (pr.providerRefundId) {
      throw new BadRequestException('Razorpay returned no refund for the stored reference — escalate to Razorpay support; nothing was changed');
    } else {
      await this.submitProviderRefund(pr, adminId); // same key, same amount
    }
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'PROVIDER_REFUND_RECONCILED', targetType: 'RefundRequest', targetId: refundRequestId, metadata: { providerRefundRowId: pr.id, found: !!found } });
    return this.prisma.refundRequest.findUnique({ where: { id: refundRequestId }, include: { providerRefund: true } });
  }

  /** For gateways with no status API here (PhonePe): an admin records the outcome they verified. */
  async confirmProviderOutcome(adminId: string, refundRequestId: string, outcome: 'PROCESSED' | 'FAILED', reference: string, reason: string) {
    if (!reason?.trim() || !reference?.trim()) throw new BadRequestException('A provider reference and a reason are required');
    const pr = await this.prisma.providerRefund.findUnique({ where: { refundRequestId } });
    if (!pr) throw new BadRequestException('This refund has no gateway part');
    if (pr.gateway === 'RAZORPAY') throw new BadRequestException('Razorpay refunds are confirmed by Razorpay itself — use "Check with Razorpay"');
    if (!['PROCESSED', 'FAILED'].includes(outcome)) throw new BadRequestException('outcome must be PROCESSED or FAILED');
    await this.applyProviderOutcome(pr.id, { providerStatus: outcome === 'PROCESSED' ? 'processed' : 'failed', error: `Confirmed manually: ${reference} — ${reason}` }, adminId);
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'PROVIDER_REFUND_CONFIRMED_MANUALLY', targetType: 'RefundRequest', targetId: refundRequestId, metadata: { outcome, reference, reason } });
    return this.prisma.refundRequest.findUnique({ where: { id: refundRequestId }, include: { providerRefund: true } });
  }

  /** Withdraws a request that was never decided (no money moved) — e.g. its decision was refused. */
  async withdrawUndecided(refundRequestId: string, reason: string) {
    const c = await this.prisma.refundRequest.updateMany({ where: { id: refundRequestId, status: { in: ACTIVE_STATUSES } }, data: { status: 'REJECTED', adminNotes: reason } });
    if (c.count === 1) await this.log(refundRequestId, undefined, undefined, 'WITHDRAWN', reason);
  }

  // ─── Partner recovery — never automatic, one shared rule for every route ──────────────

  /**
   * An explicit, admin-decided recovery FROM the partner, recorded as its own audited ledger debit.
   * Only for a job the partner was actually paid for (completed), never more than they earned on it
   * across ALL recoveries for that booking (support cases + refund requests), at most once per
   * source — the claim, the ledger entry and the audit row are one transaction.
   */
  async recordPartnerRecovery(adminId: string, input: { source: 'SUPPORT_CASE' | 'REFUND_REQUEST'; sourceId: string; orderId: string; amount: number; reason: string; sourceLabel?: string }) {
    const amount = r2(Number(input.amount));
    if (!(amount > 0)) throw new BadRequestException('Enter a recovery amount greater than zero');
    if (!input.reason?.trim()) throw new BadRequestException('A reason is required for a partner recovery');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'partner-recovery:' + input.orderId}))`;
      const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { vendorId: true, status: true, completedAt: true, vendorPayout: true } });
      if (!order?.vendorId) throw new BadRequestException('This booking has no partner to recover from');
      const paidOut = !!order.completedAt || ['COMPLETED', 'INVOICED', 'CLOSED'].includes(order.status);
      if (!paidOut) throw new BadRequestException('The partner was never paid for this booking — there is nothing to recover');
      const source: any = input.source === 'SUPPORT_CASE'
        ? await tx.supportCase.findUnique({ where: { id: input.sourceId }, select: { partnerRecovery: true, partnerRecoveredAt: true } })
        : await tx.refundRequest.findUnique({ where: { id: input.sourceId }, select: { partnerRecovery: true, partnerRecoveredAt: true } });
      if (!source) throw new NotFoundException('Recovery source not found');
      if (source.partnerRecoveredAt) {
        if (r2(Number(source.partnerRecovery)) === amount) return { applied: false, alreadyApplied: true };
        throw new BadRequestException(`A partner recovery of ₹${Number(source.partnerRecovery)} was already applied here`);
      }
      const [cases, requests] = await Promise.all([
        tx.supportCase.findMany({ where: { orderId: input.orderId, partnerRecoveredAt: { not: null } }, select: { partnerRecovery: true } }),
        tx.refundRequest.findMany({ where: { orderId: input.orderId, partnerRecoveredAt: { not: null } }, select: { partnerRecovery: true } }),
      ]);
      const already = r2([...cases, ...requests].reduce((sum: number, x: any) => sum + Number(x.partnerRecovery || 0), 0));
      const earned = Number(order.vendorPayout || 0);
      if (already + amount > earned) {
        throw new BadRequestException(`Recovery cannot exceed what the partner earned on this booking (₹${earned}; ₹${already} already recovered)`);
      }
      const claimed = input.source === 'SUPPORT_CASE'
        ? await tx.supportCase.updateMany({ where: { id: input.sourceId, partnerRecoveredAt: null }, data: { partnerRecovery: amount, partnerRecoveredAt: new Date() } })
        : await tx.refundRequest.updateMany({ where: { id: input.sourceId, partnerRecoveredAt: null }, data: { partnerRecovery: amount, partnerRecoveredAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('A recovery was just recorded here — reload');
      const note = `Recovery — ${input.sourceLabel || `${input.source} ${input.sourceId}`}: ${input.reason.trim()}`;
      const entry = await this.ledger.postEntry(tx, order.vendorId, 'ADJUSTMENT' as any, -amount, { orderId: input.orderId, createdBy: adminId, notes: note });
      await tx.serviceVendor.update({ where: { id: order.vendorId }, data: { pendingPayout: { decrement: amount } } });
      await logAudit(tx, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'PARTNER_RECOVERY', targetType: input.source === 'SUPPORT_CASE' ? 'SupportCase' : 'RefundRequest', targetId: input.sourceId, metadata: { orderId: input.orderId, vendorId: order.vendorId, amount, reason: input.reason.trim(), ledgerEntryId: entry.id } });
      return { applied: true, ledgerEntryId: entry.id };
    }, { timeout: 15000, maxWait: 10000 });
  }

  /** Admin › Refunds: record a partner recovery for a refund request (explicit decision). */
  async partnerRecoveryForRequest(adminId: string, refundRequestId: string, amount: number, reason: string) {
    const rr = await this.prisma.refundRequest.findUnique({ where: { id: refundRequestId }, select: { orderId: true } });
    if (!rr?.orderId) throw new BadRequestException('Partner recovery applies to a service booking refund');
    const res = await this.recordPartnerRecovery(adminId, { source: 'REFUND_REQUEST', sourceId: refundRequestId, orderId: rr.orderId, amount, reason, sourceLabel: `refund request ${refundRequestId}` });
    if (res.applied) await this.log(refundRequestId, adminId, UserRole.ADMIN, 'PARTNER_RECOVERED', `₹${r2(Number(amount))}: ${reason}`);
    return res;
  }
}

@ApiTags('Refunds')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('refunds')
export class RefundsController {
  constructor(private refunds: RefundsService) {}

  @Post()
  raise(@CurrentUser() u: JwtPayload, @Body() b: { orderId?: string; masterOrderId?: string; reason: string; evidenceUrls?: string[] }) {
    return this.refunds.raise(u.sub, b.orderId, b.masterOrderId, b.reason, b.evidenceUrls || []);
  }

  @Get('mine') mine(@CurrentUser() u: JwtPayload) { return this.refunds.listForCustomer(u.sub); }
  @Get('partner/mine') partnerMine(@CurrentUser() u: JwtPayload) { return this.refunds.listForPartner(u.sub); }

  @Get(':id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.refunds.getDetail(id, u.sub, u.role);
  }

  @Post(':id/partner-respond')
  partnerRespond(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { response: string }) {
    return this.refunds.partnerRespond(u.sub, id, b.response);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  adminList(@Query('status') status?: RefundRequestStatus) { return this.refunds.listForAdmin(status); }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/under-review')
  markUnderReview(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { notes?: string }) {
    return this.refunds.markUnderReview(u.sub, id, b.notes);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/escalate')
  escalate(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { notes: string }) {
    return this.refunds.escalate(u.sub, id, b.notes);
  }

  // Admin: "Check with Razorpay" for a refund that is pending or needs attention (never a second refund).
  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/reconcile')
  reconcile(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.refunds.reconcileProviderRefund(u.sub, id); }

  // Admin: record a verified outcome for a gateway with no status API here (PhonePe).
  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/confirm-provider-outcome')
  confirmProviderOutcome(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { outcome: 'PROCESSED' | 'FAILED'; reference: string; reason: string }) {
    return this.refunds.confirmProviderOutcome(u.sub, id, b.outcome, b.reference, b.reason);
  }

  // Admin: explicit recovery from the partner for this refund (never automatic).
  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/partner-recovery')
  partnerRecovery(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { amount: number; reason: string }) {
    return this.refunds.partnerRecoveryForRequest(u.sub, id, Number(b.amount), b.reason);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/decide')
  decide(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { decisionMode: RefundDecisionMode; approvedAmount?: number; walletCreditAmount?: number; gatewayRefundAmount?: number; adminNotes?: string },
  ) {
    return this.refunds.decide(u.sub, id, b.decisionMode, b);
  }
}

@Module({
  imports: [PaymentsModule, WalletModule, PaymentNotificationsModule, PartnerLedgerModule, InvoicesModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
