import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RefundDecisionMode, RefundRequestStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { WalletService, WalletModule } from '../wallet/wallet.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';

// Business rule (highest priority, per product): a refund is NEVER automatic, even for an
// online payment. Full pipeline: customer raises a request -> evidence -> partner response
// -> admin review -> final decision by ADMIN/SUPER_ADMIN only -> processed. Default decision
// is Wallet Credit; gateway refund back to the original payment method is the exception path.
const ACTIVE_STATUSES: RefundRequestStatus[] = ['REQUESTED', 'PARTNER_RESPONDED', 'UNDER_REVIEW', 'ESCALATED'];

interface DecideOptions {
  approvedAmount?: number;
  walletCreditAmount?: number;
  gatewayRefundAmount?: number;
  adminNotes?: string;
}

@Injectable()
export class RefundsService {
  constructor(
    private prisma: PrismaService, private payments: PaymentsService, private wallet: WalletService,
    private paymentNotify: PaymentNotificationsService,
  ) {}

  private log(refundRequestId: string, actorId: string | undefined, actorRole: UserRole | undefined, action: string, notes?: string) {
    return this.prisma.refundRequestLog.create({ data: { refundRequestId, actorId, actorRole, action, notes } });
  }

  async raise(customerId: string, orderId: string | undefined, masterOrderId: string | undefined, reason: string, evidenceUrls: string[]) {
    if (!orderId && !masterOrderId) throw new BadRequestException('orderId or masterOrderId is required');
    if (!reason?.trim()) throw new BadRequestException('A reason is required');

    let partnerId: string | undefined;
    if (orderId) {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      if (order.customerId !== customerId) throw new ForbiddenException();
      if (!['PAID', 'PARTIAL'].includes(order.paymentStatus)) throw new BadRequestException('This order has no payment to refund');
      partnerId = order.vendorId || undefined;
    } else {
      const mo = await this.prisma.masterOrder.findUnique({ where: { id: masterOrderId! } });
      if (!mo) throw new NotFoundException('Order not found');
      if (mo.customerId !== customerId) throw new ForbiddenException();
      if (!['PAID', 'PARTIAL'].includes(mo.paymentStatus)) throw new BadRequestException('This order has no payment to refund');
    }

    const rr = await this.prisma.refundRequest.create({
      data: { orderId, masterOrderId, customerId, reason, evidenceUrls: evidenceUrls || [], partnerId, status: 'REQUESTED' },
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
    const rr = await this.prisma.refundRequest.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } } } });
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

  private async findRefundableTransaction(orderId: string | null, masterOrderId: string | null, amount: number) {
    const tx = await this.prisma.paymentTransaction.findFirst({
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

  /**
   * The only place money (or a wallet credit) actually moves for a refund — and only ever
   * reachable by an ADMIN/SUPER_ADMIN (enforced by the controller's RolesGuard), matching
   * "neither the customer nor the partner can trigger a refund directly."
   */
  async decide(adminId: string, refundRequestId: string, decisionMode: RefundDecisionMode, opts: DecideOptions) {
    const rr = await this.getActiveRequest(refundRequestId);
    const order = rr.orderId ? await this.prisma.order.findUnique({ where: { id: rr.orderId } }) : null;
    const masterOrder = rr.masterOrderId ? await this.prisma.masterOrder.findUnique({ where: { id: rr.masterOrderId } }) : null;
    const totalAmount = Number(order?.totalAmount ?? masterOrder?.totalAmount ?? 0);
    const customerId = rr.customerId;

    let walletCreditAmount = 0;
    let gatewayRefundAmount = 0;
    let gatewayRefundId: string | undefined;
    let newStatus: RefundRequestStatus = 'PROCESSED';

    switch (decisionMode) {
      case 'NO_REFUND':
        newStatus = 'REJECTED';
        break;
      case 'FREE_REWORK':
      case 'DISCOUNT_COUPON':
        // Operational follow-up (scheduling a rework visit, issuing a coupon in the existing
        // Coupons admin screen) happens outside this pipeline — this just records the decision.
        newStatus = 'APPROVED';
        break;
      case 'WALLET_CREDIT': {
        walletCreditAmount = opts.approvedAmount ?? totalAmount;
        if (walletCreditAmount <= 0) throw new BadRequestException('approvedAmount must be greater than zero');
        await this.wallet.credit(customerId, walletCreditAmount, 'REFUND' as any, rr.orderId ?? undefined, opts.adminNotes || 'Refund approved', refundRequestId, adminId);
        break;
      }
      case 'GATEWAY_REFUND': {
        gatewayRefundAmount = opts.approvedAmount ?? totalAmount;
        if (gatewayRefundAmount <= 0) throw new BadRequestException('approvedAmount must be greater than zero');
        const tx = await this.findRefundableTransaction(rr.orderId, rr.masterOrderId, gatewayRefundAmount);
        const result = await this.payments.refundPayment(tx.id, gatewayRefundAmount);
        gatewayRefundId = result.refundId;
        break;
      }
      case 'PARTIAL_WALLET_PARTIAL_GATEWAY': {
        walletCreditAmount = opts.walletCreditAmount ?? 0;
        gatewayRefundAmount = opts.gatewayRefundAmount ?? 0;
        if (walletCreditAmount <= 0 && gatewayRefundAmount <= 0) {
          throw new BadRequestException('Specify walletCreditAmount and/or gatewayRefundAmount');
        }
        if (walletCreditAmount > 0) {
          await this.wallet.credit(customerId, walletCreditAmount, 'REFUND' as any, rr.orderId ?? undefined, opts.adminNotes || 'Partial refund (wallet)', refundRequestId, adminId);
        }
        if (gatewayRefundAmount > 0) {
          const tx = await this.findRefundableTransaction(rr.orderId, rr.masterOrderId, gatewayRefundAmount);
          const result = await this.payments.refundPayment(tx.id, gatewayRefundAmount);
          gatewayRefundId = result.refundId;
        }
        break;
      }
      default:
        throw new BadRequestException('Unknown decision mode');
    }

    const approvedAmount = walletCreditAmount + gatewayRefundAmount || opts.approvedAmount || 0;
    const updated = await this.prisma.refundRequest.update({
      where: { id: refundRequestId },
      data: {
        status: newStatus, decisionMode, approvedAmount,
        walletCreditAmount: walletCreditAmount || undefined,
        gatewayRefundAmount: gatewayRefundAmount || undefined,
        gatewayRefundId, adminNotes: opts.adminNotes, approvedBy: adminId, approvedAt: new Date(),
      },
    });
    await this.log(refundRequestId, adminId, UserRole.ADMIN, `DECIDED:${decisionMode}`, opts.adminNotes);

    // A full monetary refund (wallet + gateway together covering the whole order) is
    // reflected on the order/master-order itself. Partial refunds keep the RefundRequest +
    // WalletTransaction ledger as the source of truth — there's no distinct "partially
    // refunded" state separate from "partially paid" in the existing PaymentStatus enum.
    if (totalAmount > 0 && walletCreditAmount + gatewayRefundAmount >= totalAmount) {
      if (order) await this.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'REFUNDED' } });
      if (masterOrder) await this.prisma.masterOrder.update({ where: { id: masterOrder.id }, data: { paymentStatus: 'REFUNDED' } });
    }

    const orderNumber = order?.orderNumber ?? masterOrder?.masterOrderNumber;
    if (orderNumber) {
      const user = await this.prisma.user.findUnique({ where: { id: customerId }, select: { phone: true } });
      if (user?.phone) {
        const decisionLabel = newStatus === 'REJECTED' ? 'rejected' : 'approved';
        this.paymentNotify.refundProcessed(
          customerId, user.phone, orderNumber, approvedAmount, decisionLabel, decisionMode, rr.orderId ?? undefined,
        ).catch(() => {});
      }
    }
    return updated;
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
  imports: [PaymentsModule, WalletModule, PaymentNotificationsModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
