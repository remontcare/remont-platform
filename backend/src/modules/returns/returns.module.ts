import { Module, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationChannel, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { generateOrderNumber, addressSnapshotFields, writeOrderTimeline } from '../../common';
import { RefundsService, RefundsModule } from '../refunds/refunds.module';
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module';
import { ReverseLogisticsRateEngine } from '../logistics/reverse-logistics-rate-engine';
import { LogisticsModule } from '../logistics/logistics.module';
import { ProductLedgerService, ProductLedgerModule } from '../product-ledger/product-ledger.module';

// ═══════════════════════════════════════════════════════════════════════════
// RETURN/REPLACEMENT LOGISTICS (Phase 5) — the physical pickup-from-customer,
// deliver-to-ORIGINAL-seller leg of a return, plus the accept/reject decision
// once the seller has inspected the item. Deliberately owns no HTTP controller
// of its own: all customer/seller/rider/admin-facing routes live on the
// existing SupportCasesController, ProductVendorsController, DeliveryController
// and AdminController — this module is pure domain logic reused by all four.
//
// No dependency on SupportModule (which depends on THIS module for initiate())
// — finalize() writes the closing SupportCase/SupportCaseLog rows directly via
// Prisma instead of calling back into SupportCasesService, specifically to
// avoid a module import cycle. This mirrors how other services in this
// codebase (e.g. PartnerLedgerService) write directly to a shared table they
// don't "own" rather than round-tripping through another service.
// ═══════════════════════════════════════════════════════════════════════════

@Injectable()
export class ReturnsService {
  constructor(
    private prisma: PrismaService,
    private refunds: RefundsService,
    private notifications: NotificationsService,
    private rateEngine: ReverseLogisticsRateEngine,
    private productLedger: ProductLedgerService,
  ) {}

  // Called from SupportCasesService.executeResolution() when the policy engine's
  // RETURN_PICKUP_INITIATED resolution fires (support.module.ts) — creates the physical
  // pickup request instead of an instant refund.
  async initiate(supportCaseId: string, orderId: string, actorId?: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { include: { vendor: true } } }, take: 1 }, customer: { select: { id: true, phone: true } } },
    });
    if (!order || !order.items.length) return; // nothing to physically pick up

    const providerRef = 'DEMO-RET-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const pickupOtp = Math.floor(1000 + Math.random() * 9000).toString();
    // Business rule: return pickups must never default to fastest/express — pick the lowest-
    // cost eligible provider, same as the RTO leg below.
    const provider = await this.rateEngine.pickCheapest();
    await this.prisma.returnShipment.create({
      data: { orderId, supportCaseId, providerRef, pickupOtp, logisticsProviderId: provider.id },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: 'RETURN_PICKUP_INITIATED', actorId, actorRole: actorId ? UserRole.ADMIN : undefined });

    await this.notifications.create(order.customer.id, {
      title: 'Return pickup scheduled',
      body: `Your return request has been approved. A pickup has been scheduled — share code ${pickupOtp} with the rider when they arrive.`,
      channels: [NotificationChannel.IN_APP],
      orderId,
    }).catch(() => {});

    const vendor = order.items[0].product?.vendor;
    if (vendor) {
      await this.notifications.create(vendor.userId, {
        title: 'Incoming return pickup',
        body: `A return pickup has been scheduled for order ${order.orderNumber}. You'll be able to inspect it once it arrives.`,
        channels: [NotificationChannel.IN_APP],
        orderId,
      }).catch(() => {});
    }
  }

  // Seller-facing: ProductVendorsService.listIncomingReturns() delegates here.
  // Phase 6 — "incoming" now specifically means "still needs a seller recommendation": once
  // the seller has recommended (sellerRecommendation set), it moves to the admin's queue
  // instead and must stop appearing here, even though inspectionStatus itself stays PENDING
  // until the admin's own decision (see recordSellerRecommendation()'s doc comment for why).
  async listIncomingReturnsForVendor(vendorId: string) {
    return this.prisma.returnShipment.findMany({
      where: {
        status: 'DELIVERED', inspectionStatus: 'PENDING', sellerRecommendation: null,
        order: { items: { some: { product: { vendorId } } } },
      },
      include: { order: { select: { orderNumber: true, customerId: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Phase 6 — seller-facing: ProductVendorsService.recommendReturn() delegates here. Records
  // ONLY the seller's recommendation — never moves money and never touches inspectionStatus,
  // which is now reserved for the ADMIN's final decision (see finalize() below). This is what
  // makes the seller-recommends/admin-decides split real: a seller can never cause finalize()'s
  // PENDING guard to be satisfied, so they can never trigger a refund/replacement themselves.
  async recordSellerRecommendation(returnShipmentId: string, decision: 'ACCEPTED' | 'REJECTED', actorId: string, notes?: string): Promise<void> {
    const rs = await this.prisma.returnShipment.findUnique({ where: { id: returnShipmentId } });
    if (!rs) throw new NotFoundException();
    if (rs.status !== 'DELIVERED') throw new BadRequestException('This item has not reached the seller yet');
    if (rs.inspectionStatus !== 'PENDING') throw new BadRequestException('This return has already been decided by admin');
    await this.prisma.returnShipment.update({
      where: { id: returnShipmentId },
      data: { sellerRecommendation: decision, sellerRecommendationNotes: notes, sellerRecommendedAt: new Date() },
    });
  }

  // Admin-facing FINAL decision — the ONE place a return/replacement actually executes (see
  // AdminService.adminDecideReturn(), admin.module.ts). Reachable only via the admin controller
  // now; the seller's own route calls recordSellerRecommendation() above instead. actorId is
  // always a User.id (same convention as every other actorId in OrderTimeline/SupportCaseLog
  // elsewhere in this codebase).
  async finalize(returnShipmentId: string, decision: 'ACCEPTED' | 'REJECTED', actorId: string, actorRole: UserRole, notes?: string): Promise<void> {
    const rs = await this.prisma.returnShipment.findUnique({ where: { id: returnShipmentId }, include: { supportCase: true } });
    if (!rs) throw new NotFoundException();
    if (rs.kind !== 'RETURN') throw new BadRequestException('Use finalizeRto() for an RTO shipment');
    if (!rs.supportCase) throw new BadRequestException('This return has no linked support case');
    if (rs.status !== 'DELIVERED') throw new BadRequestException('This item has not reached the seller yet');
    if (rs.inspectionStatus !== 'PENDING') throw new BadRequestException('This return has already been inspected');

    await this.prisma.returnShipment.update({
      where: { id: returnShipmentId },
      data: { inspectionStatus: decision, inspectionNotes: notes, inspectedAt: new Date(), inspectedBy: actorId },
    });

    const kase = rs.supportCase;
    if (decision === 'REJECTED') {
      // Disputed rejection — reuse the existing DISPUTE/ADMIN_REVIEW states rather than a new
      // status; a human arbitrates from here (seller says the item wasn't returned in
      // acceptable condition).
      await this.prisma.supportCase.update({ where: { id: kase.id }, data: { status: 'ADMIN_REVIEW' } });
      await this.prisma.supportCaseLog.create({
        data: { supportCaseId: kase.id, actorId, actorRole: actorRole, action: 'RETURN_REJECTED_BY_SELLER', notes },
      });
      await writeOrderTimeline(this.prisma, { orderId: rs.orderId, status: 'RETURN_REJECTED', actorId, actorRole: actorRole });
      return;
    }

    const amount = kase.recommendedAmount != null ? Number(kase.recommendedAmount) : 0;
    if (kase.requestedRemedy === 'REPLACEMENT') {
      const replacement = await this.createReplacementOrder(rs.orderId, actorId);
      await this.prisma.supportCase.update({
        where: { id: kase.id },
        data: { status: 'RESOLVED', resolutionType: 'REPLACEMENT', resolutionReason: `Replacement order ${replacement.orderNumber} created`, decidedBy: actorId, decidedAt: new Date(), closedAt: new Date() },
      });
      await this.prisma.supportCaseLog.create({
        data: { supportCaseId: kase.id, actorId, actorRole: actorRole, action: 'RETURN_ACCEPTED', notes: `Replacement order ${replacement.orderNumber} created` },
      });
    } else {
      let refundRequestId: string | undefined;
      if (amount > 0) {
        const rr = await this.refunds.raise(kase.customerId, kase.orderId!, undefined, `Return accepted for support case ${kase.caseNumber}`, kase.evidenceUrls);
        await this.refunds.decide('SYSTEM', rr.id, 'WALLET_CREDIT', { approvedAmount: amount, adminNotes: 'Return inspection accepted' });
        refundRequestId = rr.id;
        // Phase 7 — reverse this seller's settled fees proportionally to the refunded
        // fraction (the resolved "proportional reversal" decision). A return only reaches
        // here after the original order was actually delivered (ReturnShipment.status ===
        // DELIVERED is required above), so settleProductOrder() already ran for it —
        // reverseSettlement() is a safe no-op if it somehow hadn't.
        const settledOrder = await this.prisma.order.findUnique({ where: { id: rs.orderId }, select: { totalAmount: true } });
        const ratio = settledOrder && Number(settledOrder.totalAmount) > 0 ? amount / Number(settledOrder.totalAmount) : 1;
        await this.prisma.$transaction((tx) => this.productLedger.reverseSettlement(tx, rs.orderId, ratio, 'RETURN'));
      }
      await this.prisma.supportCase.update({
        where: { id: kase.id },
        data: { status: 'RESOLVED', resolutionType: 'FULL_REFUND', resolutionAmount: amount, refundRequestId, decidedBy: actorId, decidedAt: new Date(), closedAt: new Date() },
      });
      await this.prisma.supportCaseLog.create({
        data: { supportCaseId: kase.id, actorId, actorRole: actorRole, action: 'RETURN_ACCEPTED', notes: `Refund of ₹${amount} processed` },
      });
    }
    await writeOrderTimeline(this.prisma, { orderId: rs.orderId, status: 'RETURN_ACCEPTED', actorId, actorRole: actorRole });
  }

  // Phase 6 — called from OrdersService.cancel()/AdminService.adminCancelOrder() when a
  // customer cancels a product order AFTER the outbound Shipment has already been picked up
  // (PICKED_UP/IN_TRANSIT/OUT_FOR_DELIVERY) — the product is physically in the logistics
  // network, so a plain status flip to CANCELLED would silently orphan it. No SupportCase is
  // created (this is a cancellation, not a customer-raised issue) — see the nullable
  // supportCaseId schema comment. Marks the outbound Shipment CANCELLED (never deleted — its
  // tracking history stays intact) and opens an RTO leg back to the original seller via the
  // lowest-cost eligible provider, same rule as a normal return pickup.
  async initiateRto(order: { id: string; orderNumber: string }, shipmentId: string, actorId: string, reason: string): Promise<void> {
    await this.prisma.shipment.update({ where: { id: shipmentId }, data: { status: 'CANCELLED' } });
    const provider = await this.rateEngine.pickCheapest();
    const providerRef = 'DEMO-RTO-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    // Starts at PICKED_UP, not CREATED — the item is already in the courier's hands (it was
    // already picked up for outbound delivery); there is no separate "pickup from customer"
    // step for an RTO, and no pickupOtp either (no customer present to hand a code to a rider).
    await this.prisma.returnShipment.create({
      data: { orderId: order.id, kind: 'RTO', providerRef, status: 'PICKED_UP', logisticsProviderId: provider.id },
    });
    await writeOrderTimeline(this.prisma, { orderId: order.id, status: 'RTO_INITIATED', note: reason, actorId, actorRole: UserRole.CUSTOMER });
  }

  // Phase 6 — once the RTO leg reaches the seller (DELIVERED, via the same rider state machine
  // DeliveryController already runs for RETURN shipments — no code change needed there), an
  // admin settles it with a full refund. No seller-recommendation step: an RTO is the customer
  // exercising their own cancellation right, not a quality dispute for the seller to weigh in
  // on. Reuses RefundsService unmodified, same as finalize()'s own refund branch.
  async finalizeRto(returnShipmentId: string, actorId: string, actorRole: UserRole, notes?: string): Promise<void> {
    const rs = await this.prisma.returnShipment.findUnique({
      where: { id: returnShipmentId },
      include: { order: { include: { items: { select: { vendorId: true } }, shipment: { select: { actualDeliveryCost: true } } } } },
    });
    if (!rs) throw new NotFoundException();
    if (rs.kind !== 'RTO') throw new BadRequestException('This is not an RTO shipment');
    if (rs.status !== 'DELIVERED') throw new BadRequestException('This item has not reached the seller yet');
    if (rs.inspectionStatus !== 'PENDING') throw new BadRequestException('This RTO has already been settled');

    const amount = Number(rs.order.totalAmount);
    if (amount > 0) {
      const rr = await this.refunds.raise(rs.order.customerId, rs.orderId, undefined, `RTO refund for order ${rs.order.orderNumber}`, []);
      await this.refunds.decide(actorId, rr.id, 'WALLET_CREDIT', { approvedAmount: amount, adminNotes: notes || 'RTO refund' });
    }
    // Phase 7 — an RTO always happens BEFORE the outbound shipment reaches the customer (a
    // cancellation after delivery must go through a normal return instead — see
    // OrdersService.cancel()'s comment), so settleProductOrder() never ran for this order and
    // there is nothing to reverse. Remont still paid the courier for a completed round trip
    // though — per the resolved decision, the seller absorbs that wasted-trip delivery cost
    // directly, independent of the normal settlement flow.
    const vendorId = rs.order.items?.find((it) => it.vendorId)?.vendorId;
    const deliveryCost = Number(rs.order.shipment?.actualDeliveryCost || 0);
    if (vendorId && deliveryCost > 0) {
      await this.prisma.$transaction((tx) => this.productLedger.chargeUnsettledDeliveryCost(tx, rs.orderId, vendorId, deliveryCost));
    }
    await this.prisma.returnShipment.update({
      where: { id: returnShipmentId },
      data: { inspectionStatus: 'ACCEPTED', inspectionNotes: notes, inspectedAt: new Date(), inspectedBy: actorId },
    });
    await writeOrderTimeline(this.prisma, { orderId: rs.orderId, status: 'RTO_REFUNDED', actorId, actorRole });
  }

  // A replacement is a new, zero-value Order re-entering the exact same seller-accept-> pack
  // -> ship pipeline as any normal product order — no special-casing anywhere downstream.
  // Guarded independently of the SupportCase status check (defense in depth against a
  // double-click creating two replacements for the same original order).
  async createReplacementOrder(originalOrderId: string, actorId?: string) {
    const existing = await this.prisma.order.findFirst({ where: { replacementOfOrderId: originalOrderId } });
    if (existing) throw new BadRequestException('A replacement has already been created for this order');

    const original = await this.prisma.order.findUnique({
      where: { id: originalOrderId },
      include: { items: true, address: true },
    });
    if (!original) throw new NotFoundException('Original order not found');

    const count = await this.prisma.order.count();
    const orderNumber = generateOrderNumber('REP', count);

    const replacement = await this.prisma.order.create({
      data: {
        orderNumber,
        customerId: original.customerId,
        type: 'PRODUCT',
        addressId: original.addressId,
        ...addressSnapshotFields(original.address),
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        paymentMethod: original.paymentMethod || undefined,
        replacementOfOrderId: original.id,
        productFulfillmentStage: 'AWAITING_SELLER',
        productFulfillmentAt: new Date(),
        items: {
          create: original.items.map((i) => ({
            productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, totalPrice: 0,
            vendorId: i.vendorId, pickupLocationId: i.pickupLocationId,
          })),
        },
      },
    });
    await writeOrderTimeline(this.prisma, { orderId: replacement.id, status: 'REPLACEMENT_CREATED', note: `Replacement for ${original.orderNumber}`, actorId, actorRole: actorId ? UserRole.PRODUCT_VENDOR : undefined });
    return replacement;
  }
}

@Module({
  imports: [RefundsModule, NotificationsModule, LogisticsModule, ProductLedgerModule],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
