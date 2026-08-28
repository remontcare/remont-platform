import { Module, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationChannel, UserRole, WarrantyDecision } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { writeOrderTimeline } from '../../common';
import { RefundsService, RefundsModule } from '../refunds/refunds.module';
import { ReturnsService, ReturnsModule } from '../returns/returns.module';
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module';

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT WARRANTY (Phase 6) — brand/manufacturer warranty claims. Distinct
// from a normal return/replacement (ReturnsModule) and from the pre-existing
// PartnerHold(WARRANTY_HOLD) (a vendor-payout defect-liability hold for
// SERVICE jobs — confirmed unrelated). No own controller: routes live on the
// existing ProductVendorsController/SupportCasesController/AdminController,
// same shape as ReturnsModule. Writes SupportCase/SupportCaseLog rows
// directly via Prisma (not through SupportCasesService) to avoid a
// SupportModule import cycle, mirroring ReturnsService.finalize()'s own
// documented reasoning.
// ═══════════════════════════════════════════════════════════════════════════

@Injectable()
export class WarrantyService {
  constructor(
    private prisma: PrismaService,
    private refunds: RefundsService,
    private returns: ReturnsService,
    private notifications: NotificationsService,
  ) {}

  private async nextCaseNumber(): Promise<string> {
    const count = await this.prisma.warrantyCase.count();
    return `WAR-${(count + 1).toString().padStart(6, '0')}`;
  }

  // Called from SupportCasesService.executeResolution() when the policy engine's
  // WARRANTY_CLAIM_OPENED resolution fires (support.module.ts).
  async openCase(supportCaseId: string, orderId: string, productId: string | undefined, customerId: string, orderItemId?: string): Promise<void> {
    if (!productId) return; // nothing to claim warranty on without a specific product
    const caseNumber = await this.nextCaseNumber();
    await this.prisma.warrantyCase.create({
      data: { caseNumber, orderId, orderItemId, productId, customerId, supportCaseId, status: 'SELLER_REVIEW' },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: 'WARRANTY_CLAIM_OPENED' });

    const product = await this.prisma.product.findUnique({ where: { id: productId }, include: { vendor: true } });
    if (product?.vendor) {
      await this.notifications.create(product.vendor.userId, {
        title: 'Incoming warranty claim',
        body: `A warranty claim has been raised for order on product "${product.name}". Please review and recommend a resolution.`,
        channels: [NotificationChannel.IN_APP],
        orderId,
      }).catch(() => {});
    }
  }

  // Seller-facing: ProductVendorsService.listIncomingWarrantyCases() delegates here.
  async listIncomingForVendor(vendorId: string) {
    return this.prisma.warrantyCase.findMany({
      where: { status: 'SELLER_REVIEW', product: { vendorId } },
      include: { order: { select: { orderNumber: true, customerId: true } }, product: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Seller-facing: records ONLY the seller's recommendation — never a final decision. Only
  // AdminService.adminDecideWarranty() may call decide() below.
  async recordSellerRecommendation(warrantyCaseId: string, decision: WarrantyDecision, actorId: string, notes?: string): Promise<void> {
    const wc = await this.prisma.warrantyCase.findUnique({ where: { id: warrantyCaseId } });
    if (!wc) throw new NotFoundException();
    if (wc.status !== 'SELLER_REVIEW') throw new BadRequestException('This warranty case is not awaiting seller review');
    await this.prisma.warrantyCase.update({
      where: { id: warrantyCaseId },
      data: { sellerRecommendation: decision, sellerRecommendationNotes: notes, sellerRecommendedAt: new Date(), status: 'ADMIN_REVIEW' },
    });
  }

  async listForAdmin(status?: string) {
    return this.prisma.warrantyCase.findMany({
      where: status ? { status: status as any } : {},
      include: { order: { select: { orderNumber: true, customerId: true } }, product: { select: { name: true, vendorId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listForCustomer(customerId: string) {
    return this.prisma.warrantyCase.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } });
  }

  // Admin-facing FINAL decision — the ONE place a warranty claim actually resolves.
  async decide(warrantyCaseId: string, decision: WarrantyDecision, adminId: string, notes?: string): Promise<void> {
    const wc = await this.prisma.warrantyCase.findUnique({ where: { id: warrantyCaseId }, include: { order: { include: { items: true } } } });
    if (!wc) throw new NotFoundException();
    if (wc.status !== 'ADMIN_REVIEW') throw new BadRequestException('This warranty case is not awaiting an admin decision');

    if (decision === 'APPROVED_REFUND') {
      const item = wc.orderItemId ? wc.order.items.find((i) => i.id === wc.orderItemId) : undefined;
      const amount = item ? Number(item.totalPrice) : Number(wc.order.totalAmount);
      if (amount > 0) {
        const rr = await this.refunds.raise(wc.customerId, wc.orderId, undefined, `Warranty claim ${wc.caseNumber} approved for refund`, []);
        await this.refunds.decide(adminId, rr.id, 'WALLET_CREDIT', { approvedAmount: amount, adminNotes: notes || 'Warranty claim approved' });
      }
    } else if (decision === 'APPROVED_REPLACEMENT') {
      await this.returns.createReplacementOrder(wc.orderId, adminId);
    }
    // APPROVED_REPAIR / REJECTED — record-only, no existing repair-dispatch system to call into
    // (same restraint SupportCasesService itself documents for FREE_REWORK/NO_REFUND).

    await this.prisma.warrantyCase.update({
      where: { id: warrantyCaseId },
      data: {
        status: decision === 'REJECTED' ? 'REJECTED' : 'RESOLVED',
        finalDecision: decision, decidedBy: adminId, decidedAt: new Date(), resolutionNotes: notes, closedAt: new Date(),
      },
    });
    await this.prisma.supportCase.update({
      where: { id: wc.supportCaseId },
      data: { status: decision === 'REJECTED' ? 'RESOLVED' : 'RESOLVED', resolutionReason: notes || `Warranty ${decision}`, decidedBy: adminId, decidedAt: new Date(), closedAt: new Date() },
    }).catch(() => {});
    await this.prisma.supportCaseLog.create({
      data: { supportCaseId: wc.supportCaseId, actorId: adminId, actorRole: UserRole.ADMIN, action: `WARRANTY_${decision}`, notes },
    }).catch(() => {});
    await writeOrderTimeline(this.prisma, { orderId: wc.orderId, status: `WARRANTY_${decision}`, actorId: adminId, actorRole: UserRole.ADMIN, note: notes });
  }
}

@Module({
  imports: [RefundsModule, ReturnsModule, NotificationsModule],
  providers: [WarrantyService],
  exports: [WarrantyService],
})
export class WarrantyModule {}
