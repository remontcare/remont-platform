import { Module, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationChannel, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { generateOrderNumber, addressSnapshotFields, writeOrderTimeline } from '../../common';
import { RefundsService, RefundsModule } from '../refunds/refunds.module';
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module';

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
    await this.prisma.returnShipment.create({
      data: { orderId, supportCaseId, providerRef, pickupOtp },
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
  async listIncomingReturnsForVendor(vendorId: string) {
    return this.prisma.returnShipment.findMany({
      where: {
        status: 'DELIVERED', inspectionStatus: 'PENDING',
        order: { items: { some: { product: { vendorId } } } },
      },
      include: { order: { select: { orderNumber: true, customerId: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Seller-facing: ProductVendorsService.inspectReturn() delegates here after authorizing that
  // the caller actually owns a product on the linked order. Also reachable via an admin
  // override (AdminService.adminDecideReturn(), for a disputed rejection) — actorRole
  // distinguishes the two in the audit trail. actorId is always a User.id (same convention
  // as every other actorId in OrderTimeline/SupportCaseLog elsewhere in this codebase).
  async finalize(returnShipmentId: string, decision: 'ACCEPTED' | 'REJECTED', actorId: string, actorRole: UserRole, notes?: string): Promise<void> {
    const rs = await this.prisma.returnShipment.findUnique({ where: { id: returnShipmentId }, include: { supportCase: true } });
    if (!rs) throw new NotFoundException();
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
  imports: [RefundsModule, NotificationsModule],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
