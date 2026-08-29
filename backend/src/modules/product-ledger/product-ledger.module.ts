import { Module, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ProductLedgerEntryType, ProductHoldStatus, ProductHoldType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';

const DEFAULT_RETURN_WINDOW_DAYS = 7; // same fallback SupportPolicyEngine's SUPPORT_SETTING_DEFAULTS uses for support_product_return_window_days

// Phase 7 — PRODUCT-seller marketplace settlement ledger. A parallel, ProductVendor-keyed
// mirror of PartnerLedgerService (backend/src/modules/partner-ledger) — same single-entry-
// running-balance idiom, same hold/release lifecycle — kept as a separate table/service
// rather than extending PartnerLedgerService because PartnerLedgerEntry/PartnerHold are
// hard-FK'd to ServiceVendor; weakening that non-null relation to admit a second vendor
// type would risk every existing SERVICE-side ledger query.
@Injectable()
export class ProductLedgerService {
  constructor(private prisma: PrismaService) {}

  private async getSettingNumber(key: string, fallback: number): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  // Same lost-update-race fix as PartnerLedgerService.postEntry(): lock the vendor's own row
  // first so two concurrent postings for the same vendor can never both read the same "last"
  // balanceAfter under READ COMMITTED and corrupt the running total.
  async postEntry(
    tx: any,
    vendorId: string,
    type: ProductLedgerEntryType,
    amount: number,
    meta?: { orderId?: string; settlementId?: string; notes?: string; createdBy?: string },
  ) {
    await tx.$queryRaw`SELECT id FROM "ProductVendor" WHERE id = ${vendorId} FOR UPDATE`;
    const last = await tx.productVendorLedgerEntry.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });
    const balanceAfter = Number(last?.balanceAfter || 0) + amount;
    return tx.productVendorLedgerEntry.create({
      data: {
        vendorId, type, amount, balanceAfter,
        orderId: meta?.orderId, settlementId: meta?.settlementId, notes: meta?.notes, createdBy: meta?.createdBy,
      },
    });
  }

  // Called once, exactly at delivery — see LogisticsService.onShipmentDelivered(), which
  // race-guards this via a conditional updateMany claim so a double-fire can never double-
  // post. Reads the commission/marketing/gateway/gstOnFees already resolved+snapshotted at
  // checkout (MasterOrdersService.checkout()), merges in the real delivery cost now that the
  // shipment exists, posts every fee line as a signed ledger entry, then — per the resolved
  // "hold payouts until the return window closes" decision — posts the net credit as a HOLD
  // (not a direct pendingPayout increment) and opens a ProductVendorHold that a daily cron
  // (ProductHoldSweepService below) releases once the product's return window passes.
  async settleProductOrder(
    tx: any,
    order: { id: string; productsAmount: any; productFeeBreakdown: any; items: { vendorId: string | null; product?: { returnWindowDays: number | null } | null }[] },
    shipment: { logisticsProviderId: string | null; actualDeliveryCost: any; deliveredAt: Date | null },
    deliveredAt: Date,
  ) {
    const vendorId = order.items.find((it) => it.vendorId)?.vendorId;
    if (!vendorId) return; // defensive — every PRODUCT order's items are vendor-scoped at creation

    const p = (order.productFeeBreakdown as any) || {};
    const commission = Number(p.commission?.amount || 0);
    const marketing = Number(p.marketing?.amount || 0);
    const gateway = Number(p.gateway?.amount || 0);
    const gstOnFees = Number(p.gstOnFees?.amount || 0);
    const deliveryAmount = Number(shipment.actualDeliveryCost || 0);

    const fullBreakdown = {
      ...p,
      delivery: { amount: deliveryAmount, logisticsProviderId: shipment.logisticsProviderId },
    };
    await tx.order.update({ where: { id: order.id }, data: { productFeeBreakdown: fullBreakdown } });

    const productsAmount = Number(order.productsAmount);
    await this.postEntry(tx, vendorId, 'GROSS_SALE', productsAmount, { orderId: order.id });
    if (commission > 0) await this.postEntry(tx, vendorId, 'COMMISSION', -commission, { orderId: order.id, notes: p.commission?.ruleLabel });
    if (gstOnFees > 0) await this.postEntry(tx, vendorId, 'GST_ON_FEES', -gstOnFees, { orderId: order.id });
    if (marketing > 0) await this.postEntry(tx, vendorId, 'MARKETING_FEE', -marketing, { orderId: order.id, notes: p.marketing?.ruleLabel });
    if (gateway > 0) await this.postEntry(tx, vendorId, 'GATEWAY_FEE', -gateway, { orderId: order.id, notes: p.gateway?.ruleLabel });
    if (deliveryAmount > 0) await this.postEntry(tx, vendorId, 'DELIVERY_COST', -deliveryAmount, { orderId: order.id });

    const netCredit = Math.round((productsAmount - commission - gstOnFees - marketing - gateway - deliveryAmount) * 100) / 100;
    await tx.productVendor.update({ where: { id: vendorId }, data: { totalEarnings: { increment: netCredit } } });
    if (netCredit <= 0) return; // nothing left to hold/pay out (fees exceeded the sale — rare, but not an error)

    await this.postEntry(tx, vendorId, 'HOLD', -netCredit, { orderId: order.id, notes: 'Held for return-window duration' });
    const perProductWindow = order.items.find((it) => it.vendorId === vendorId)?.product?.returnWindowDays;
    const windowDays = perProductWindow ?? await this.getSettingNumber('support_product_return_window_days', DEFAULT_RETURN_WINDOW_DAYS);
    const releaseDueAt = new Date(deliveredAt.getTime() + windowDays * 86_400_000);
    await tx.productVendorHold.create({
      data: { vendorId, type: ProductHoldType.RETURN_WINDOW_HOLD, amount: netCredit, remaining: netCredit, orderId: order.id, releaseDueAt },
    });
  }

  // Standalone charge for a pre-delivery RTO (courier picked up, item never reached the
  // customer, so settleProductOrder() above never ran — no GROSS_SALE was ever posted to
  // reverse). Per the resolved decision, the seller absorbs this wasted-trip delivery cost
  // directly, independent of the normal settlement flow.
  async chargeUnsettledDeliveryCost(tx: any, orderId: string, vendorId: string, amount: number) {
    if (amount <= 0) return;
    await this.postEntry(tx, vendorId, 'DELIVERY_COST', -amount, { orderId, notes: 'Pre-delivery RTO — delivery cost charged to seller' });
    await tx.productVendor.update({ where: { id: vendorId }, data: { totalEarnings: { decrement: amount } } });
  }

  // Reverses a settled order's fee lines proportionally to the refunded fraction (the
  // resolved "proportional reversal" decision) — new signed entries, never overwriting the
  // original rows, same convention as PartnerLedgerService.refundLeadCost(). Deducts from the
  // order's ProductVendorHold first if it's still HELD (mirrors PartnerLedgerService.
  // deductFromHold()); once the hold has already RELEASED (past the return window), the
  // reversal debits the seller's live balance directly instead.
  async reverseSettlement(tx: any, orderId: string, ratio: number, kind: 'RETURN' | 'RTO') {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { productFeeBreakdown: true, productsAmount: true, items: { select: { vendorId: true } } },
    });
    const vendorId = order?.items.find((it: any) => it.vendorId)?.vendorId;
    const p = (order?.productFeeBreakdown as any) || {};
    if (!vendorId || (!p.commission && !p.marketing && !p.gateway && !p.delivery)) return; // never settled — nothing to reverse (e.g. RTO before delivery)

    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const entryType: ProductLedgerEntryType = kind === 'RETURN' ? 'RETURN_ADJUSTMENT' : 'RTO_ADJUSTMENT';
    // Fee lines were posted as debits (negative) — reversing means crediting the seller back
    // that same (scaled) amount, sign +1; GROSS_SALE was a credit, so reversing it debits the
    // seller, sign -1. `sign` is applied directly to the posted entry, not bolted on after.
    const reverse = async (label: string, amount: number, sign: 1 | -1) => {
      const scaled = Math.round(amount * clampedRatio * sign * 100) / 100;
      if (scaled === 0) return 0;
      await this.postEntry(tx, vendorId, entryType, scaled, { orderId, notes: `${label} reversal (${Math.round(clampedRatio * 100)}%)` });
      return scaled;
    };
    let netReversal = 0;
    netReversal += await reverse('Gross sale', Number(order.productsAmount || 0), -1);
    netReversal += await reverse('Commission', Number(p.commission?.amount || 0), 1);
    netReversal += await reverse('GST on fees', Number(p.gstOnFees?.amount || 0), 1);
    netReversal += await reverse('Marketing fee', Number(p.marketing?.amount || 0), 1);
    netReversal += await reverse('Gateway fee', Number(p.gateway?.amount || 0), 1);
    netReversal += await reverse('Delivery cost', Number(p.delivery?.amount || 0), 1);

    const hold = await tx.productVendorHold.findFirst({ where: { orderId, status: ProductHoldStatus.HELD } });
    if (hold) {
      const deduction = Math.min(-netReversal, Number(hold.remaining)); // netReversal is negative when the seller owes money back (the common case)
      if (deduction > 0) {
        const newRemaining = Number(hold.remaining) - deduction;
        await tx.productVendorHold.update({
          where: { id: hold.id },
          data: {
            remaining: newRemaining,
            ...(newRemaining <= 0 ? { status: ProductHoldStatus.FORFEITED, releasedAt: new Date(), notes: `Fully consumed by ${kind.toLowerCase()}` } : {}),
          },
        });
      }
    } else {
      await tx.productVendor.update({ where: { id: vendorId }, data: { pendingPayout: { increment: netReversal } } });
    }
    await tx.productVendor.update({ where: { id: vendorId }, data: { totalEarnings: { increment: netReversal } } });
  }
}

// Same daily-cron idiom as WarrantyHoldSweepService (partner-ledger.module.ts) — releases
// every ProductVendorHold whose return window has passed into the seller's withdrawable
// pendingPayout balance.
@Injectable()
export class ProductHoldSweepService {
  private readonly logger = new Logger(ProductHoldSweepService.name);
  constructor(private prisma: PrismaService, private ledger: ProductLedgerService) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async sweep() {
    const due = await this.prisma.productVendorHold.findMany({
      where: { status: ProductHoldStatus.HELD, releaseDueAt: { lte: new Date() } },
      select: { id: true },
    });
    for (const hold of due) {
      try {
        await this.prisma.$transaction((tx) => this.releaseHold(tx, hold.id));
      } catch (e) {
        this.logger.error(`Failed to auto-release product hold ${hold.id}: ${e.message}`);
      }
    }
    if (due.length) this.logger.log(`Auto-released ${due.length} matured product hold(s)`);
  }

  private async releaseHold(tx: any, holdId: string) {
    const hold = await tx.productVendorHold.findUnique({ where: { id: holdId } });
    if (!hold) return;
    const claimed = await tx.productVendorHold.updateMany({
      where: { id: holdId, status: ProductHoldStatus.HELD },
      data: { status: ProductHoldStatus.RELEASED, remaining: 0, releasedAt: new Date() },
    });
    if (claimed.count !== 1) return; // already handled concurrently
    const remaining = Number(hold.remaining);
    if (remaining > 0) {
      await this.ledger.postEntry(tx, hold.vendorId, 'HOLD_RELEASE', remaining, { orderId: hold.orderId || undefined });
      await tx.productVendor.update({ where: { id: hold.vendorId }, data: { pendingPayout: { increment: remaining } } });
    }
  }
}

@Module({
  providers: [ProductLedgerService, ProductHoldSweepService],
  exports: [ProductLedgerService],
})
export class ProductLedgerModule {}
