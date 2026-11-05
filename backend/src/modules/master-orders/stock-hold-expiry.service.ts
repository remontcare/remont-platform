import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { MasterOrderStatus, OrderStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { PaymentsService } from '../payments/payments.module';
import { releaseProductStock, releaseUnpaidOrderWallet, writeOrderTimeline } from '../../common';

/** SiteSetting that sets how long an unpaid online order may hold product stock. 0 = never expire. */
export const STOCK_HOLD_SETTING = 'product_stock_hold_minutes';
export const DEFAULT_STOCK_HOLD_MINUTES = 120;
export const STOCK_HOLD_EXPIRED_REASON = 'Payment not completed in time — reserved stock released';
const ACTIVE_REFUND_STATUSES = ['REQUESTED', 'PARTNER_RESPONDED', 'UNDER_REVIEW', 'ESCALATED'] as const;

export async function loadStockHoldMinutes(prisma: any): Promise<number> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: STOCK_HOLD_SETTING } });
    if (!row) return DEFAULT_STOCK_HOLD_MINUTES;
    const n = Number(row.value);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STOCK_HOLD_MINUTES;
  } catch {
    return DEFAULT_STOCK_HOLD_MINUTES;
  }
}

/**
 * Product stock is reserved at checkout. An online order that is never paid used to hold that
 * stock forever (abandoned or failed payment), so the product looked sold out. This sweep
 * cancels such an order after the hold window, gives its units back and returns any wallet
 * amount — but never while a payment on it may still succeed (checked with Razorpay).
 *
 * If a payment still lands on an order after it was cancelled, the money is recorded as a refund
 * request for admin review instead of being silently kept (onCapturedAfterCancel).
 */
@Injectable()
export class StockHoldExpiryService {
  private readonly logger = new Logger(StockHoldExpiryService.name);
  constructor(private prisma: PrismaService, private payments: PaymentsService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(now = new Date()): Promise<{ expired: number; skipped: number }> {
    const holdMinutes = await loadStockHoldMinutes(this.prisma);
    if (!holdMinutes) return { expired: 0, skipped: 0 };
    const cutoff = new Date(now.getTime() - holdMinutes * 60_000);
    const stale = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_PAYMENT, paymentStatus: { notIn: ['PAID', 'PARTIAL'] },
        stockReservedAt: { not: null, lt: cutoff }, stockReleasedAt: null,
      },
      select: { id: true, masterOrderId: true },
      orderBy: { stockReservedAt: 'asc' }, take: 100,
    });
    // A cart is one payment: it expires as a whole (its master id is what the gateway order is on).
    const units = new Map<string, { masterOrderId?: string; orderId?: string }>();
    for (const o of stale) {
      if (o.masterOrderId) units.set(`m:${o.masterOrderId}`, { masterOrderId: o.masterOrderId });
      else units.set(`o:${o.id}`, { orderId: o.id });
    }
    let expired = 0, skipped = 0;
    for (const unit of units.values()) {
      try {
        if (await this.expireUnit(unit)) expired++; else skipped++;
      } catch (e: any) {
        skipped++;
        this.logger.warn(`Stock-hold expiry skipped ${unit.masterOrderId || unit.orderId}: ${e.message}`);
      }
    }
    if (expired) this.logger.log(`Stock-hold expiry: ${expired} unpaid order(s) cancelled, stock released`);
    return { expired, skipped };
  }

  /** Cancels one unpaid cart/order if no payment on it can still succeed. Returns true if cancelled. */
  async expireUnit(unit: { masterOrderId?: string; orderId?: string }): Promise<boolean> {
    const paymentKey = unit.masterOrderId || unit.orderId!;
    const txs = await this.prisma.paymentTransaction.findMany({
      where: { orderId: paymentKey }, select: { status: true, gateway: true, gatewayOrderId: true },
    });
    if (txs.some((t) => t.status === 'PAID' || t.status === 'PARTIAL')) return false;
    for (const t of txs) {
      if (!t.gatewayOrderId || t.status === 'FAILED') continue;
      // Only Razorpay can be asked; anything else that is not known to have failed is left alone.
      if (t.gateway !== 'RAZORPAY') return false;
      if (await this.payments.razorpayPaymentMayBeInProgress(t.gatewayOrderId)) return false;
    }

    const cancelledIds = await this.prisma.$transaction(async (tx) => {
      if (unit.masterOrderId) {
        const claim = await tx.masterOrder.updateMany({
          where: { id: unit.masterOrderId, status: MasterOrderStatus.PENDING_PAYMENT, paymentStatus: { notIn: ['PAID', 'PARTIAL'] } },
          data: { status: MasterOrderStatus.CANCELLED },
        });
        if (claim.count !== 1) return [] as string[];
      }
      const children = await tx.order.findMany({
        where: unit.masterOrderId ? { masterOrderId: unit.masterOrderId } : { id: unit.orderId },
      });
      const ids: string[] = [];
      for (const child of children) {
        const c = await tx.order.updateMany({
          where: { id: child.id, status: OrderStatus.PENDING_PAYMENT, paymentStatus: { notIn: ['PAID', 'PARTIAL'] } },
          data: { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: STOCK_HOLD_EXPIRED_REASON },
        });
        if (c.count !== 1) continue;
        await releaseProductStock(tx, child.id);
        await releaseUnpaidOrderWallet(tx, child, `Order ${child.orderNumber} not paid in time — cancelled`);
        ids.push(child.id);
      }
      return ids;
    });
    for (const orderId of cancelledIds) {
      await writeOrderTimeline(this.prisma, { orderId, status: OrderStatus.CANCELLED, note: STOCK_HOLD_EXPIRED_REASON, actorRole: UserRole.ADMIN }).catch(() => undefined);
    }
    return cancelledIds.length > 0;
  }

  /**
   * Safety net for money that arrives after an order was cancelled (expired, or cancelled by the
   * customer/admin while a payment was still open): the confirm path refuses a cancelled order,
   * so the captured amount is recorded as a refund request for admin review. Never moves money.
   */
  @OnEvent('payment.order.captured', { async: true })
  async onCapturedAfterCancel(p: { paymentTransactionId?: string; orderId?: string | null }) {
    try {
      if (!p?.orderId) return;
      const mo = await this.prisma.masterOrder.findUnique({ where: { id: p.orderId }, select: { id: true, status: true, paymentStatus: true, customerId: true, masterOrderNumber: true } });
      const order = mo ? null : await this.prisma.order.findUnique({ where: { id: p.orderId }, select: { id: true, status: true, paymentStatus: true, customerId: true, orderNumber: true } });
      const target = mo || order;
      // Only money that never became this order's payment: a paid order that was later cancelled
      // already has its own refund handling (raised on cancellation).
      if (!target || target.status !== 'CANCELLED' || ['PAID', 'PARTIAL', 'REFUNDED'].includes(String(target.paymentStatus))) return;
      const where = mo ? { masterOrderId: mo.id } : { orderId: order!.id };
      const open = await this.prisma.refundRequest.findFirst({ where: { ...where, status: { in: [...ACTIVE_REFUND_STATUSES] } }, select: { id: true } });
      if (open) return;
      const number = mo ? mo.masterOrderNumber : order!.orderNumber;
      await this.prisma.refundRequest.create({
        data: { ...where, customerId: target.customerId, reason: `Payment received after order ${number} was cancelled — refund due`, evidenceUrls: [], status: 'REQUESTED' },
      });
      this.logger.warn(`Payment captured on cancelled order ${number} — refund request created for admin review`);
    } catch (e: any) {
      this.logger.error(`Late-payment refund request failed for ${p?.orderId}: ${e.message}`);
    }
  }
}
