import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  UserRole, SupportItemType, SupportIssueType, SupportCaseStatus, SupportResolutionType,
  NotificationChannel,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, logAudit } from '../../common';
import { RefundsService, RefundsModule } from '../refunds/refunds.module';
import { AdminService, AdminModule } from '../admin/admin.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module';
import { ReturnsService, ReturnsModule } from '../returns/returns.module';

// ═══════════════════════════════════════════════════════════════════════════
// ORDER HELP & SUPPORT — a structured "select item -> select issue -> check
// status -> check policy -> resolve" layer on top of the existing RefundRequest
// pipeline. This module NEVER moves money, reassigns a partner, or cancels an
// order itself — every resolution that requires one of those calls the existing
// service that already does it correctly (RefundsService, AdminService). See
// the "item-level scoping" note below for why a multi-item product issue is
// always a partial refund against the shared Order rather than a status change
// on OrderItem (which has no status field, and none is added here).
// ═══════════════════════════════════════════════════════════════════════════

const SUPPORT_SETTING_DEFAULTS: Record<string, number> = {
  support_visit_charge: 200,
  support_diagnosis_charge: 150,
  support_partner_assignment_sla_min: 60, // mirrors DispatchRetryService's existing 60-min retry sweep
  support_product_return_window_days: 7,
};

type ServiceStage = 'NOT_ASSIGNED' | 'ASSIGNED' | 'EN_ROUTE' | 'STARTED' | 'COMPLETED' | 'CLOSED' | 'PENDING';

interface PolicyConfig {
  visitCharge: number;
  diagnosisCharge: number;
  slaMin: number;
  returnWindowDays: number;
}

interface RecommendInput {
  itemType: SupportItemType;
  issueType: SupportIssueType;
  order: { status: string; vendorId: string | null; dispatchAttempts: number; createdAt: Date; completedAt: Date | null };
  amountBasis: number;
  policy: PolicyConfig;
  warranty: { days: number; percent: number };
}

interface Recommendation {
  routeType: 'AUTO_RESOLUTION' | 'SUPPORT_CASE' | 'DISPUTE';
  resolutionType: SupportResolutionType | null;
  amount: number | null;
  reasonForCustomer: string;
  policyApplied: string;
}

const money = (n: number) => Math.round(n * 100) / 100;

// The set of resolutions that move customer money — every one of them is executed by
// creating a RefundRequest and driving it through the EXISTING RefundsService.raise()/
// .decide() pipeline (wallet credit, hold-netting, order.paymentStatus flip, customer
// notification all already happen there). Nothing here talks to WalletService or
// PaymentsService directly.
const REFUND_RESOLUTIONS: SupportResolutionType[] = [
  'FULL_REFUND', 'PARTIAL_REFUND', 'REFUND_MINUS_VISIT', 'REFUND_MINUS_DIAGNOSIS',
];

@Injectable()
export class SupportPolicyEngine {
  constructor(private prisma: PrismaService) {}

  // Same prisma.siteSetting.findUnique + Number() parse + hardcoded-fallback pattern as
  // PartnerLedgerService.getSettingNumber() — admin edits these via the existing generic
  // Site Settings screen (group 'support'), no new settings UI needed.
  private async getSetting(key: string): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : SUPPORT_SETTING_DEFAULTS[key];
  }

  async getPolicyConfig(): Promise<PolicyConfig> {
    const [visitCharge, diagnosisCharge, slaMin, returnWindowDays] = await Promise.all([
      this.getSetting('support_visit_charge'),
      this.getSetting('support_diagnosis_charge'),
      this.getSetting('support_partner_assignment_sla_min'),
      this.getSetting('support_product_return_window_days'),
    ]);
    return { visitCharge, diagnosisCharge, slaMin, returnWindowDays };
  }

  // Normalizes the existing OrderStatus lifecycle into the stages the spec's flows are
  // written against — no new status values, purely a read-side projection.
  deriveServiceStage(order: { status: string; vendorId: string | null }): ServiceStage {
    if (!order.vendorId) {
      return order.status === 'CANCELLED' || order.status === 'REFUNDED' ? 'CLOSED' : 'NOT_ASSIGNED';
    }
    switch (order.status) {
      case 'VENDOR_ASSIGNED': return 'ASSIGNED';
      case 'VENDOR_EN_ROUTE': return 'EN_ROUTE';
      case 'STARTED':
      case 'IN_PROGRESS':
      case 'EXTRA_WORK_ADDED': return 'STARTED';
      case 'COMPLETED':
      case 'INVOICED':
      case 'CLOSED': return 'COMPLETED';
      case 'CANCELLED':
      case 'REFUNDED': return 'CLOSED';
      default: return 'PENDING';
    }
  }

  getIssueOptions(itemType: SupportItemType, stage: ServiceStage): SupportIssueType[] {
    if (itemType === 'PRODUCT') {
      const opts: SupportIssueType[] = [];
      if (stage !== 'COMPLETED' && stage !== 'CLOSED') opts.push('NOT_DELIVERED', 'DELIVERED_LATE');
      opts.push('WRONG_PRODUCT', 'DAMAGED_PRODUCT', 'MISSING_ITEM');
      if (stage === 'PENDING' || stage === 'NOT_ASSIGNED') opts.push('CANCEL_PRODUCT');
      if (stage === 'COMPLETED') opts.push('RETURN_PRODUCT');
      opts.push('OTHER_ISSUE');
      return opts;
    }
    const opts: SupportIssueType[] = [];
    if (stage === 'NOT_ASSIGNED' || stage === 'PENDING') opts.push('PARTNER_NOT_ASSIGNED');
    if (stage === 'ASSIGNED' || stage === 'EN_ROUTE') opts.push('PARTNER_ON_THE_WAY', 'PARTNER_DID_NOT_ARRIVE');
    if (stage === 'EN_ROUTE' || stage === 'STARTED') opts.push('PARTNER_ARRIVED');
    if (stage === 'STARTED') opts.push('SERVICE_STARTED_ISSUE');
    if (stage === 'COMPLETED') opts.push('SERVICE_COMPLETED_ISSUE_NOT_FIXED');
    opts.push('OTHER_ISSUE');
    return opts;
  }

  // Sections 5-9 of the spec, as a pure decision table. Every charge/window comes from
  // `policy` (SiteSetting-backed) or `warranty` (the EXISTING per-category warranty config,
  // via PartnerLedgerService.getWarrantyDefaults) — nothing is hardcoded here.
  recommend(input: RecommendInput): Recommendation {
    const { itemType, issueType, order, amountBasis, policy, warranty } = input;

    if (itemType === 'PRODUCT') {
      switch (issueType) {
        case 'NOT_DELIVERED':
          return {
            routeType: 'SUPPORT_CASE', resolutionType: 'FULL_REFUND', amount: money(amountBasis),
            reasonForCustomer: 'Your order is marked as not delivered. Our team will verify with the delivery partner/seller before processing a refund.',
            policyApplied: 'Not-delivered claims are always confirmed by the support team before a refund is issued.',
          };
        case 'DELIVERED_LATE':
          // There is no stored "promised delivery date" on Order/Delivery today, so lateness
          // can't be quantified automatically — always a human call, never auto-resolved.
          return {
            routeType: 'SUPPORT_CASE', resolutionType: null, amount: null,
            reasonForCustomer: 'Our team will check the delay against the promised delivery window and get back to you.',
            policyApplied: 'Delivery-delay compensation is reviewed case-by-case.',
          };
        case 'WRONG_PRODUCT':
        case 'DAMAGED_PRODUCT':
        case 'MISSING_ITEM': {
          const withinWindow = (Date.now() - order.createdAt.getTime()) / 86_400_000 <= policy.returnWindowDays;
          // Phase 5 — was an instant FULL_REFUND with zero physical pickup before real product
          // fulfillment existed. Now that pickup/inspection is real, this schedules a return
          // pickup instead; the refund (or replacement) only fires once the seller's
          // inspection accepts the item — see RETURN_PICKUP_INITIATED in REFUND_RESOLUTIONS'
          // sibling handling in executeResolution() below.
          return withinWindow
            ? {
                routeType: 'AUTO_RESOLUTION', resolutionType: 'RETURN_PICKUP_INITIATED', amount: money(amountBasis),
                reasonForCustomer: `Within the ${policy.returnWindowDays}-day return window — a pickup has been scheduled. Once the seller inspects the returned item, your refund or replacement will be processed.`,
                policyApplied: `Return window: ${policy.returnWindowDays} days from order date.`,
              }
            : {
                routeType: 'SUPPORT_CASE', resolutionType: 'NO_REFUND', amount: null,
                reasonForCustomer: `This is being reported after the ${policy.returnWindowDays}-day return window. Our team will review.`,
                policyApplied: `Return window: ${policy.returnWindowDays} days from order date (expired).`,
              };
        }
        case 'CANCEL_PRODUCT': {
          const cancellable = ['PENDING_PAYMENT', 'CONFIRMED', 'VENDOR_ASSIGNED'].includes(order.status);
          return cancellable
            ? {
                routeType: 'AUTO_RESOLUTION', resolutionType: 'FULL_REFUND', amount: money(amountBasis),
                reasonForCustomer: 'Order has not shipped yet — full refund approved for cancellation.',
                policyApplied: 'Free cancellation before shipment.',
              }
            : {
                routeType: 'SUPPORT_CASE', resolutionType: null, amount: null,
                reasonForCustomer: 'This order is already past the free-cancellation stage. Please use Return Product instead — our team will review.',
                policyApplied: 'Cancellation is only automatic before shipment.',
              };
        }
        case 'RETURN_PRODUCT': {
          const withinWindow = (Date.now() - order.createdAt.getTime()) / 86_400_000 <= policy.returnWindowDays;
          // Phase 5 — see the WRONG_PRODUCT/DAMAGED_PRODUCT/MISSING_ITEM comment above: this
          // used to be an instant FULL_REFUND. Deliberate, customer-facing behaviour change —
          // a refund is no longer instant within the return window, since physical pickup and
          // seller inspection are now real gates before money moves.
          return withinWindow
            ? {
                routeType: 'AUTO_RESOLUTION', resolutionType: 'RETURN_PICKUP_INITIATED', amount: money(amountBasis),
                reasonForCustomer: `Within the ${policy.returnWindowDays}-day return window — a pickup has been scheduled. Once the seller inspects the returned item, your refund or replacement will be processed.`,
                policyApplied: `Return window: ${policy.returnWindowDays} days from order date.`,
              }
            : {
                routeType: 'SUPPORT_CASE', resolutionType: 'NO_REFUND', amount: null,
                reasonForCustomer: `The ${policy.returnWindowDays}-day return window has passed. Our team will review.`,
                policyApplied: `Return window: ${policy.returnWindowDays} days from order date (expired).`,
              };
        }
        default:
          return {
            routeType: 'SUPPORT_CASE', resolutionType: null, amount: null,
            reasonForCustomer: 'Our support team will review your issue.',
            policyApplied: 'General review — no automatic policy applies.',
          };
      }
    }

    // SERVICE
    switch (issueType) {
      case 'PARTNER_NOT_ASSIGNED': {
        const minutesSinceConfirmed = (Date.now() - order.createdAt.getTime()) / 60_000;
        const slaExpired = minutesSinceConfirmed > policy.slaMin || order.dispatchAttempts >= 2;
        return slaExpired
          ? {
              routeType: 'SUPPORT_CASE', resolutionType: 'FULL_REFUND', amount: money(amountBasis),
              reasonForCustomer: `No partner has been assigned within the normal ${policy.slaMin}-minute window. Our team will reassign or refund.`,
              policyApplied: `Assignment SLA: ${policy.slaMin} minutes (expired).`,
            }
          : {
              routeType: 'AUTO_RESOLUTION', resolutionType: 'NO_REFUND', amount: null,
              reasonForCustomer: `A partner is still being assigned — this is within the normal ${policy.slaMin}-minute window. Please check back shortly.`,
              policyApplied: `Assignment SLA: ${policy.slaMin} minutes (not yet expired).`,
            };
      }
      case 'PARTNER_ON_THE_WAY': {
        const refund = Math.max(0, money(amountBasis - policy.visitCharge));
        return {
          routeType: 'AUTO_RESOLUTION', resolutionType: 'REFUND_MINUS_VISIT', amount: refund,
          reasonForCustomer: `Partner had already started travelling. As per the applicable cancellation policy, a visit charge was deducted.\n\nService Amount: ₹${amountBasis}\nVisit Charge: -₹${policy.visitCharge}\nRefund: ₹${refund}`,
          policyApplied: `Visit charge on cancellation after dispatch: ₹${policy.visitCharge}.`,
        };
      }
      case 'PARTNER_ARRIVED': {
        const deduction = policy.visitCharge + policy.diagnosisCharge;
        const refund = Math.max(0, money(amountBasis - deduction));
        return {
          routeType: 'AUTO_RESOLUTION', resolutionType: 'REFUND_MINUS_DIAGNOSIS', amount: refund,
          reasonForCustomer: `Partner had already arrived and begun diagnosis. Visit and diagnosis charges apply.\n\nService Amount: ₹${amountBasis}\nVisit Charge: -₹${policy.visitCharge}\nDiagnosis Charge: -₹${policy.diagnosisCharge}\nRefund: ₹${refund}`,
          policyApplied: `Visit charge ₹${policy.visitCharge} + diagnosis charge ₹${policy.diagnosisCharge} on cancellation after arrival.`,
        };
      }
      case 'PARTNER_DID_NOT_ARRIVE':
        // No GPS-arrival evidence is tracked on Order today — always routed for a human to
        // check partner status/timeline before any refund, per the spec's explicit "refund
        // only according to actual policy/status" rule for this case.
        return {
          routeType: 'SUPPORT_CASE', resolutionType: 'FULL_REFUND', amount: money(amountBasis),
          reasonForCustomer: 'We are checking the partner’s status and arrival record. Our team will confirm next steps shortly.',
          policyApplied: 'No-show claims are always confirmed by the support team before a refund/reassignment.',
        };
      case 'SERVICE_STARTED_ISSUE':
        return {
          routeType: 'SUPPORT_CASE', resolutionType: null, amount: null,
          reasonForCustomer: 'Our support team will review the issue raised during the service.',
          policyApplied: 'In-progress issues are reviewed case-by-case.',
        };
      case 'SERVICE_COMPLETED_ISSUE_NOT_FIXED': {
        const daysSinceCompletion = order.completedAt ? (Date.now() - order.completedAt.getTime()) / 86_400_000 : Infinity;
        const withinWarranty = warranty.days > 0 && daysSinceCompletion <= warranty.days;
        return withinWarranty
          ? {
              routeType: 'DISPUTE', resolutionType: 'FREE_REWORK', amount: null,
              reasonForCustomer: `This is within the ${warranty.days}-day warranty period — the partner should revisit and fix this at no charge.`,
              policyApplied: `Warranty period: ${warranty.days} days from completion.`,
            }
          : {
              routeType: 'SUPPORT_CASE', resolutionType: 'NEW_SERVICE_REQUIRED', amount: null,
              reasonForCustomer: `The warranty window (${warranty.days} days) has passed — this will need to be booked as a new service.`,
              policyApplied: `Warranty period: ${warranty.days} days from completion (expired).`,
            };
      }
      default:
        return {
          routeType: 'SUPPORT_CASE', resolutionType: null, amount: null,
          reasonForCustomer: 'Our support team will review your issue.',
          policyApplied: 'General review — no automatic policy applies.',
        };
    }
  }
}

@Injectable()
export class SupportCasesService {
  constructor(
    private prisma: PrismaService,
    private policyEngine: SupportPolicyEngine,
    private refunds: RefundsService,
    private admin: AdminService,
    private ledger: PartnerLedgerService,
    private paymentNotify: PaymentNotificationsService,
    private notifications: NotificationsService,
    private returns: ReturnsService,
  ) {}

  private log(supportCaseId: string, actorId: string | undefined, actorRole: UserRole | undefined, action: string, notes?: string) {
    return this.prisma.supportCaseLog.create({ data: { supportCaseId, actorId, actorRole, action, notes } });
  }

  private async nextCaseNumber(): Promise<string> {
    // Same count-based, namespaced-by-nothing-unique idiom as invoice numbers — the real
    // uniqueness guarantee is the DB @unique constraint + row id, this is only a display label.
    const count = await this.prisma.supportCase.count();
    return `SUP-${(count + 1).toString().padStart(6, '0')}`;
  }

  private async loadOrderForCase(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, service: { include: { category: true } } },
    });
  }

  async getContext(customerId: string, orderId: string, orderItemId?: string, issueType?: SupportIssueType) {
    if (!orderId) throw new BadRequestException('orderId is required');
    const order = await this.loadOrderForCase(orderId);
    if (!order || order.customerId !== customerId) throw new ForbiddenException();

    let orderItem: { id: string; totalPrice: any } | null = null;
    if (orderItemId) {
      orderItem = order.items.find((i) => i.id === orderItemId) || null;
      if (!orderItem) throw new BadRequestException('This item does not belong to the specified order');
    }

    const itemType: SupportItemType = order.items.length > 0 ? 'PRODUCT' : 'SERVICE';
    const stage = this.policyEngine.deriveServiceStage(order);
    const issueOptions = this.policyEngine.getIssueOptions(itemType, stage);
    const result: any = { itemType, stage, issueOptions };

    if (issueType) {
      const amountBasis = orderItem ? Number(orderItem.totalPrice) : Number(order.totalAmount);
      const policy = await this.policyEngine.getPolicyConfig();
      const warranty = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
      result.recommendation = this.policyEngine.recommend({ itemType, issueType, order, amountBasis, policy, warranty });
    }
    return result;
  }

  async openCase(customerId: string, dto: {
    orderId: string; orderItemId?: string; issueType: SupportIssueType; description?: string; evidenceUrls?: string[];
    requestedRemedy?: 'REFUND' | 'REPLACEMENT';
  }) {
    if (!dto.orderId) throw new BadRequestException('orderId is required');
    if (!dto.issueType) throw new BadRequestException('issueType is required');
    const order = await this.loadOrderForCase(dto.orderId);
    if (!order || order.customerId !== customerId) throw new ForbiddenException();

    let orderItem: { id: string; totalPrice: any } | null = null;
    if (dto.orderItemId) {
      orderItem = order.items.find((i) => i.id === dto.orderItemId) || null;
      if (!orderItem) throw new BadRequestException('This item does not belong to the specified order');
    }

    const itemType: SupportItemType = order.items.length > 0 ? 'PRODUCT' : 'SERVICE';
    const amountBasis = orderItem ? Number(orderItem.totalPrice) : Number(order.totalAmount);
    const policy = await this.policyEngine.getPolicyConfig();
    const warranty = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
    const rec = this.policyEngine.recommend({ itemType, issueType: dto.issueType, order, amountBasis, policy, warranty });

    const caseNumber = await this.nextCaseNumber();
    const created = await this.prisma.supportCase.create({
      data: {
        caseNumber, orderId: order.id, orderItemId: orderItem?.id, customerId,
        partnerId: order.vendorId || undefined,
        itemType, issueType: dto.issueType, description: dto.description,
        evidenceUrls: dto.evidenceUrls || [],
        requestedRemedy: dto.requestedRemedy,
        statusSnapshot: order.status,
        status: rec.routeType === 'DISPUTE' ? 'DISPUTE' : 'OPEN',
        routeType: rec.routeType,
        recommendedResolution: rec.resolutionType ?? undefined,
        recommendedAmount: rec.amount ?? undefined,
        recommendationReason: rec.reasonForCustomer,
        policyApplied: rec.policyApplied,
      },
    });
    await this.log(created.id, customerId, UserRole.CUSTOMER, 'OPENED', `${dto.issueType}${dto.description ? `: ${dto.description}` : ''}`);

    if (rec.routeType === 'AUTO_RESOLUTION') {
      return this.executeResolution(created.id, rec.resolutionType, rec.amount, rec.reasonForCustomer, null);
    }

    if (rec.routeType === 'DISPUTE' && order.vendorId) {
      const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: order.vendorId } });
      const withPartnerWaiting = await this.prisma.supportCase.update({ where: { id: created.id }, data: { status: 'WAITING_PARTNER' } });
      if (vendor) {
        await this.notifications.create(vendor.userId, {
          title: 'Customer raised an issue on a completed job',
          body: `Case ${caseNumber}: the customer says the issue wasn't fixed. Please respond with your side.`,
          channels: [NotificationChannel.IN_APP],
          orderId: order.id,
        }).catch(() => {});
      }
      return withPartnerWaiting;
    }

    return created;
  }

  async partnerRespond(vendorUserId: string, caseId: string, response: string) {
    const kase = await this.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!kase) throw new NotFoundException();
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v || kase.partnerId !== v.id) throw new ForbiddenException();
    if (kase.status !== 'WAITING_PARTNER') throw new BadRequestException('This case is not awaiting a partner response');

    const updated = await this.prisma.supportCase.update({
      where: { id: caseId },
      data: { status: 'ADMIN_REVIEW', partnerResponse: response, partnerRespondedAt: new Date() },
    });
    await this.log(caseId, vendorUserId, UserRole.SERVICE_VENDOR, 'PARTNER_RESPONDED', response);
    return updated;
  }

  // The ONE place a resolution is actually carried out. `actorId: null` means a true system
  // auto-resolution (no admin involved) — everything else is identical either way.
  private async executeResolution(
    caseId: string, resolutionType: SupportResolutionType | null, amount: number | null,
    reason: string, actorId: string | null, opts?: { newVendorId?: string },
  ) {
    const kase = await this.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!kase) throw new NotFoundException('Support case not found');

    let refundRequestId: string | undefined;
    if (resolutionType && REFUND_RESOLUTIONS.includes(resolutionType) && amount && amount > 0) {
      const rr = await this.refunds.raise(
        kase.customerId, kase.orderId, undefined,
        `Support case ${kase.caseNumber} (${kase.issueType}): ${reason}`, kase.evidenceUrls,
      );
      // Default is WALLET_CREDIT per the same business rule RefundsService itself documents —
      // this module never picks a gateway refund; an admin who wants that opens the
      // RefundRequest directly via the existing Refunds admin screen.
      await this.refunds.decide(actorId || 'SYSTEM', rr.id, 'WALLET_CREDIT', { approvedAmount: amount, adminNotes: reason });
      refundRequestId = rr.id;
    } else if (resolutionType === 'REASSIGN_PARTNER') {
      if (!actorId) throw new BadRequestException('Reassigning a partner requires admin review');
      if (!opts?.newVendorId) throw new BadRequestException('newVendorId is required to reassign a partner');
      await this.admin.forceAssignVendor(kase.orderId, opts.newVendorId, actorId, UserRole.ADMIN);
    } else if (resolutionType === 'RETURN_PICKUP_INITIATED') {
      // Phase 5 — schedules the physical pickup instead of moving money; the case stays open
      // (IN_REVIEW, not RESOLVED) until the seller's inspection accepts/rejects the item and
      // ReturnsService.finalize() closes it out for real.
      await this.returns.initiate(kase.id, kase.orderId, actorId || undefined);
    }
    // NO_REFUND / FREE_REVISIT / FREE_REWORK / NEW_SERVICE_REQUIRED / CUSTOMER_PAYABLE /
    // PARTNER_LIABILITY / SPLIT_LIABILITY are recorded on the case only — there is no existing
    // "charge the customer more" or "penalize the vendor beyond their warranty hold" system to
    // call, and this module does not invent one (see plan doc). Admin can follow up manually
    // (e.g. the existing AdminService.postLedgerAdjustment for a vendor-side consequence).

    const isReturnPickup = resolutionType === 'RETURN_PICKUP_INITIATED';
    const updated = await this.prisma.supportCase.update({
      where: { id: caseId },
      data: {
        status: isReturnPickup ? 'IN_REVIEW' : 'RESOLVED',
        resolutionType: resolutionType ?? undefined,
        resolutionAmount: amount ?? undefined,
        resolutionReason: reason,
        decidedBy: actorId ?? undefined,
        decidedAt: isReturnPickup ? undefined : new Date(),
        refundRequestId,
        closedAt: isReturnPickup ? undefined : new Date(),
      },
    });
    await this.log(caseId, actorId ?? undefined, actorId ? UserRole.ADMIN : undefined, isReturnPickup ? 'RETURN_PICKUP_SCHEDULED' : 'RESOLVED', `${resolutionType ?? 'REVIEWED'}: ${reason}`);
    if (actorId) {
      await logAudit(this.prisma, {
        actorId, actorRole: UserRole.ADMIN, action: 'SUPPORT_CASE_RESOLVED',
        targetType: 'SupportCase', targetId: caseId, metadata: { resolutionType, amount, reason },
      });
    }

    const [customer, order] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: kase.customerId }, select: { phone: true } }),
      this.prisma.order.findUnique({ where: { id: kase.orderId }, select: { orderNumber: true } }),
    ]);
    if (customer?.phone && order) {
      this.paymentNotify.supportCaseUpdate(
        kase.customerId, customer.phone, order.orderNumber, kase.caseNumber,
        resolutionType || 'Reviewed', reason, kase.orderId,
      ).catch(() => {});
    }
    return updated;
  }

  async adminDecide(
    adminId: string, caseId: string, resolutionType: SupportResolutionType,
    amount: number | undefined, reason: string, opts?: { newVendorId?: string },
  ) {
    if (!reason?.trim()) throw new BadRequestException('A reason is required for every support-case decision');
    const kase = await this.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!kase) throw new NotFoundException('Support case not found');
    if (kase.status === 'RESOLVED' || kase.status === 'CLOSED') throw new BadRequestException('This case has already been resolved');
    // Phase 5 — a case already routed to a physical return pickup must be closed out via the
    // seller's inspection (or the admin return-override), not re-decided generically here —
    // otherwise an admin could refund/replace while the item is still in transit.
    if (kase.resolutionType === 'RETURN_PICKUP_INITIATED') {
      throw new BadRequestException('This return is awaiting pickup/inspection — decide it from the Deliveries & Returns queue instead');
    }
    return this.executeResolution(caseId, resolutionType, amount ?? null, reason, adminId, opts);
  }

  async listForCustomer(customerId: string) {
    return this.prisma.supportCase.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } });
  }

  async listForPartner(vendorUserId: string) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new NotFoundException('Partner profile not found');
    return this.prisma.supportCase.findMany({ where: { partnerId: v.id }, orderBy: { createdAt: 'desc' } });
  }

  async listForAdmin(status?: SupportCaseStatus) {
    const cases = await this.prisma.supportCase.findMany({
      where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200,
    });
    const orderIds = [...new Set(cases.map((c) => c.orderId))];
    const customerIds = [...new Set(cases.map((c) => c.customerId))];
    const partnerIds = [...new Set(cases.map((c) => c.partnerId).filter(Boolean))] as string[];
    const [orders, customers, partners]: [
      { id: string; orderNumber: string }[],
      { id: string; name: string; phone: string }[],
      { id: string; fullName: string }[],
    ] = await Promise.all([
      orderIds.length ? this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } }) : [],
      customerIds.length ? this.prisma.user.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true } }) : [],
      partnerIds.length ? this.prisma.serviceVendor.findMany({ where: { id: { in: partnerIds } }, select: { id: true, fullName: true } }) : [],
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const partnerById = new Map(partners.map((p) => [p.id, p]));
    return cases.map((c) => ({
      ...c,
      orderNumber: orderById.get(c.orderId)?.orderNumber,
      customerName: customerById.get(c.customerId)?.name,
      customerPhone: customerById.get(c.customerId)?.phone,
      partnerName: c.partnerId ? partnerById.get(c.partnerId)?.fullName : undefined,
    }));
  }

  async getDetail(id: string, actorUserId: string, actorRole: UserRole) {
    const kase = await this.prisma.supportCase.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } } } });
    if (!kase) throw new NotFoundException();
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    if (adminRoles.includes(actorRole) || kase.customerId === actorUserId) return kase;
    if (actorRole === UserRole.SERVICE_VENDOR) {
      const v = await this.prisma.serviceVendor.findUnique({ where: { userId: actorUserId } });
      if (v && kase.partnerId === v.id) return kase;
    }
    throw new ForbiddenException();
  }
}

@ApiTags('Support')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportCasesController {
  constructor(private support: SupportCasesService) {}

  @Post('cases/context')
  context(@CurrentUser() u: JwtPayload, @Body() b: { orderId: string; orderItemId?: string; issueType?: SupportIssueType }) {
    return this.support.getContext(u.sub, b.orderId, b.orderItemId, b.issueType);
  }

  @Post('cases')
  open(@CurrentUser() u: JwtPayload, @Body() b: {
    orderId: string; orderItemId?: string; issueType: SupportIssueType; description?: string; evidenceUrls?: string[];
    requestedRemedy?: 'REFUND' | 'REPLACEMENT';
  }) {
    return this.support.openCase(u.sub, b);
  }

  @Get('cases/mine') mine(@CurrentUser() u: JwtPayload) { return this.support.listForCustomer(u.sub); }
  @Get('cases/partner/mine') partnerMine(@CurrentUser() u: JwtPayload) { return this.support.listForPartner(u.sub); }

  @Get('cases/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.support.getDetail(id, u.sub, u.role);
  }

  @Post('cases/:id/partner-respond')
  partnerRespond(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { response: string }) {
    return this.support.partnerRespond(u.sub, id, b.response);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('cases')
  adminList(@Query('status') status?: SupportCaseStatus) { return this.support.listForAdmin(status); }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('cases/:id/decide')
  decide(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { resolutionType: SupportResolutionType; amount?: number; reason: string; newVendorId?: string },
  ) {
    return this.support.adminDecide(u.sub, id, b.resolutionType, b.amount, b.reason, { newVendorId: b.newVendorId });
  }
}

@Module({
  imports: [RefundsModule, AdminModule, PartnerLedgerModule, PaymentNotificationsModule, NotificationsModule, ReturnsModule],
  controllers: [SupportCasesController],
  providers: [SupportPolicyEngine, SupportCasesService],
  exports: [SupportPolicyEngine, SupportCasesService],
})
export class SupportModule {}
