import {
  Injectable, BadRequestException, NotFoundException, ConflictException,
} from '@nestjs/common';
import { ProductVendorSettlement, SettlementMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { ProductLedgerService } from '../product-ledger/product-ledger.service';

/** Settlement status values */
export enum SettlementStatus {
  PENDING = 'PENDING',           // Created, awaiting admin review
  APPROVED = 'APPROVED',         // Admin approved, ready to process
  PROCESSING = 'PROCESSING',     // Money being transferred
  COMPLETED = 'COMPLETED',       // Successfully settled
  FAILED = 'FAILED',             // Transfer failed
  CANCELLED = 'CANCELLED',       // Disputed/held/cancelled
}

export interface ProductSettlementDTO {
  id: string;
  vendorId: string;
  vendorName: string;
  amount: number;
  mode: SettlementMode;
  status: string;
  referenceNumber?: string;
  notes?: string;
  paidBy?: string;
  approvedAt?: Date;
  completedAt?: Date;
  failureReason?: string;
  createdAt: Date;
  paidAt?: Date;
}

@Injectable()
export class ProductSettlementsService {
  constructor(
    private prisma: PrismaService,
    private ledger: ProductLedgerService,
  ) {}

  /**
   * Request a settlement payout for a seller.
   * Seller calls this when they want to withdraw earnings.
   * Amount must be:
   * - > 0
   * - <= pendingPayout (available balance)
   * - >= minPayoutAmount (seller's configured minimum)
   */
  async requestSettlement(
    vendorId: string,
    amount: number,
    mode: SettlementMode,
    notes?: string,
  ): Promise<ProductSettlementDTO> {
    if (!amount || amount <= 0) {
      throw new BadRequestException('Settlement amount must be > 0');
    }

    return this.prisma.$transaction(async (tx) => {
      // Lock vendor row
      await tx.$queryRaw`SELECT id FROM "ProductVendor" WHERE id = ${vendorId} FOR UPDATE`;

      const vendor = await tx.productVendor.findUnique({
        where: { id: vendorId },
        select: {
          id: true,
          businessName: true,
          pendingPayout: true,
          totalEarnings: true,
          minPayoutAmount: true,
          autoApprove: true,
        },
      });

      if (!vendor) throw new NotFoundException('Seller not found');

      const minPayout = Number(vendor.minPayoutAmount || 5000); // ₹50 default
      if (amount < minPayout) {
        throw new BadRequestException(
          `Minimum payout amount is ₹${minPayout}. You can request again after reaching this amount.`,
        );
      }

      if (amount > Number(vendor.pendingPayout)) {
        throw new BadRequestException(
          `Insufficient balance. Available: ₹${vendor.pendingPayout}`,
        );
      }

      // Check for duplicate pending request (same vendor, same amount, within 24h)
      const recentPending = await tx.productVendorSettlement.findFirst({
        where: {
          vendorId,
          status: SettlementStatus.PENDING,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (recentPending && Number(recentPending.amount) === amount) {
        throw new ConflictException(
          'You already have a pending settlement request for this amount. Please wait for admin review.',
        );
      }

      // Determine initial status
      const initialStatus = vendor.autoApprove ? SettlementStatus.APPROVED : SettlementStatus.PENDING;

      const settlement = await tx.productVendorSettlement.create({
        data: {
          vendorId,
          amount,
          mode,
          status: initialStatus,
          notes: notes || `Settlement requested via ${mode}`,
          createdAt: new Date(),
          ...(initialStatus === SettlementStatus.APPROVED ? {
            approvedAt: new Date(),
            paidBy: 'SYSTEM_AUTO_APPROVE',
          } : {}),
        },
      });

      return this.formatSettlementDTO(settlement, vendor.businessName);
    });
  }

  /**
   * Admin approves a pending settlement.
   * Admin can optionally reduce amount or add notes.
   */
  async approveSettlement(
    settlementId: string,
    adminUserId: string,
    adjustedAmount?: number,
    additionalNotes?: string,
  ): Promise<ProductSettlementDTO> {
    return this.prisma.$transaction(async (tx) => {
      const settlement = await tx.productVendorSettlement.findUnique({
        where: { id: settlementId },
        include: { vendor: true },
      });

      if (!settlement) throw new NotFoundException('Settlement not found');
      if (settlement.status !== SettlementStatus.PENDING) {
        throw new BadRequestException(
          `Cannot approve settlement with status ${settlement.status}`,
        );
      }

      const finalAmount = adjustedAmount || Number(settlement.amount);
      if (finalAmount <= 0) {
        throw new BadRequestException('Amount must be > 0');
      }

      const updated = await tx.productVendorSettlement.update({
        where: { id: settlementId },
        data: {
          status: SettlementStatus.APPROVED,
          amount: finalAmount,
          approvedAt: new Date(),
          paidBy: adminUserId,
          notes: additionalNotes
            ? `${settlement.notes}\n[Admin: ${additionalNotes}]`
            : settlement.notes,
        },
      });

      return this.formatSettlementDTO(updated, settlement.vendor.businessName);
    });
  }

  /**
   * Mark a settlement as completed (money actually transferred).
   * Updates ledger and decrements vendor's pendingPayout.
   */
  async markAsCompleted(
    settlementId: string,
    adminUserId: string,
    referenceNumber?: string,
  ): Promise<ProductSettlementDTO> {
    return this.prisma.$transaction(async (tx) => {
      const settlement = await tx.productVendorSettlement.findUnique({
        where: { id: settlementId },
        include: { vendor: true },
      });

      if (!settlement) throw new NotFoundException('Settlement not found');
      if (settlement.status !== SettlementStatus.APPROVED) {
        throw new BadRequestException(
          `Settlement must be APPROVED before marking as completed. Current status: ${settlement.status}`,
        );
      }

      // Lock vendor
      await tx.$queryRaw`SELECT id FROM "ProductVendor" WHERE id = ${settlement.vendorId} FOR UPDATE`;

      // Verify balance still sufficient
      const vendor = await tx.productVendor.findUnique({
        where: { id: settlement.vendorId },
      });

      if (Number(settlement.amount) > Number(vendor.pendingPayout)) {
        throw new BadRequestException(
          'Vendor balance changed. Settlement amount exceeds current pending payout.',
        );
      }

      // Update settlement
      const updated = await tx.productVendorSettlement.update({
        where: { id: settlementId },
        data: {
          status: SettlementStatus.COMPLETED,
          completedAt: new Date(),
          referenceNumber: referenceNumber || settlement.referenceNumber,
          paidAt: new Date(),
        },
      });

      // Decrement vendor's pendingPayout
      await tx.productVendor.update({
        where: { id: settlement.vendorId },
        data: { pendingPayout: { decrement: settlement.amount } },
      });

      // Post ledger entry (WITHDRAWAL)
      await this.ledger.postEntry(
        tx,
        settlement.vendorId,
        'WITHDRAWAL',
        -Number(settlement.amount),
        {
          settlementId,
          createdBy: adminUserId,
          referenceNumber,
          notes: `Settlement completed via ${settlement.mode}${referenceNumber ? ` (ref: ${referenceNumber})` : ''}`,
        },
      );

      return this.formatSettlementDTO(updated, settlement.vendor.businessName);
    });
  }

  /**
   * Mark a settlement as failed (transfer didn't go through).
   * This reverses the approval and returns it to PENDING.
   */
  async markAsFailed(
    settlementId: string,
    failureReason: string,
  ): Promise<ProductSettlementDTO> {
    const settlement = await this.prisma.productVendorSettlement.findUnique({
      where: { id: settlementId },
      include: { vendor: true },
    });

    if (!settlement) throw new NotFoundException('Settlement not found');

    if (![SettlementStatus.PROCESSING, SettlementStatus.APPROVED].includes(settlement.status as any)) {
      throw new BadRequestException(
        `Cannot mark as failed. Current status: ${settlement.status}`,
      );
    }

    const updated = await this.prisma.productVendorSettlement.update({
      where: { id: settlementId },
      data: {
        status: SettlementStatus.FAILED,
        failureReason,
        notes: `${settlement.notes}\n[FAILED: ${failureReason}]`,
      },
    });

    return this.formatSettlementDTO(updated, settlement.vendor.businessName);
  }

  /**
   * Get seller's pending payouts summary
   */
  async summaryForVendor(vendorId: string) {
    const vendor = await this.prisma.productVendor.findUnique({
      where: { id: vendorId },
      select: {
        totalEarnings: true,
        pendingPayout: true,
        businessName: true,
      },
    });

    if (!vendor) throw new NotFoundException('Seller not found');

    const paidOut = Number(vendor.totalEarnings) - Number(vendor.pendingPayout);
    const pendingSettlements = await this.prisma.productVendorSettlement.findMany({
      where: {
        vendorId,
        status: { in: [SettlementStatus.PENDING, SettlementStatus.APPROVED] },
      },
      select: { amount: true },
    });

    const pendingAmount = pendingSettlements.reduce((sum, s) => sum + Number(s.amount), 0);

    return {
      businessName: vendor.businessName,
      totalEarnings: vendor.totalEarnings,
      paidOut,
      pendingPayout: vendor.pendingPayout,
      pendingSettlements: pendingAmount,
      withdrawable: Number(vendor.pendingPayout) - pendingAmount,
    };
  }

  /**
   * List settlements for a vendor (seller's view)
   */
  async listForVendor(vendorId: string, limit = 50) {
    const settlements = await this.prisma.productVendorSettlement.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { vendor: { select: { businessName: true } } },
    });

    return settlements.map((s) => this.formatSettlementDTO(s, s.vendor.businessName));
  }

  /**
   * Admin: list all pending settlements (for review/approval)
   */
  async listPending(limit = 100) {
    const settlements = await this.prisma.productVendorSettlement.findMany({
      where: { status: SettlementStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { vendor: { select: { businessName: true } } },
    });

    return settlements.map((s) => this.formatSettlementDTO(s, s.vendor.businessName));
  }

  /**
   * Admin: list all settlements with optional filters
   */
  async listAll(
    vendorId?: string,
    status?: string,
    from?: Date,
    to?: Date,
    limit = 100,
  ) {
    const settlements = await this.prisma.productVendorSettlement.findMany({
      where: {
        ...(vendorId ? { vendorId } : {}),
        ...(status ? { status } : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { vendor: { select: { businessName: true } } },
    });

    return settlements.map((s) => this.formatSettlementDTO(s, s.vendor.businessName));
  }

  /**
   * Helper: format settlement for API response
   */
  private formatSettlementDTO(
    settlement: any,
    vendorName: string,
  ): ProductSettlementDTO {
    return {
      id: settlement.id,
      vendorId: settlement.vendorId,
      vendorName,
      amount: Number(settlement.amount),
      mode: settlement.mode,
      status: settlement.status,
      referenceNumber: settlement.referenceNumber,
      notes: settlement.notes,
      paidBy: settlement.paidBy,
      approvedAt: settlement.approvedAt,
      completedAt: settlement.completedAt,
      failureReason: settlement.failureReason,
      createdAt: settlement.createdAt,
      paidAt: settlement.paidAt,
    };
  }
}
