import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  UserRole, SupportItemType, SupportIssueType, SupportCaseStatus, SupportResolutionType,
  NotificationChannel,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, logAudit, recordPartnerArrival, resolveCityIdForRules, resolveCancellationPenalty } from '../../common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { RefundsService, RefundsModule, RefundCapacityExceeded } from '../refunds/refunds.module';
import { AdminService, AdminModule } from '../admin/admin.module';
import { PartnerLedgerService, PartnerLedgerModule } from '../partner-ledger/partner-ledger.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module';
import { ReturnsService, ReturnsModule } from '../returns/returns.module';
import { WarrantyService, WarrantyModule } from '../warranty/warranty.module';

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

// Phase 6 — per-product after-sales policy snapshot (Product.returnable/replaceable/
// warrantyAvailable etc., schema.prisma), passed in by the caller (getContext()/openCase())
// rather than fetched here — SupportPolicyEngine stays a pure, DB-free decision function.
interface ProductPolicy {
  returnable: boolean;
  replaceable: boolean;
  warrantyAvailable: boolean;
}

interface RecommendInput {
  itemType: SupportItemType;
  issueType: SupportIssueType;
  order: { status: string; vendorId: string | null; dispatchAttempts: number; createdAt: Date; completedAt: Date | null };
  amountBasis: number;
  policy: PolicyConfig;
  warranty: { days: number; percent: number };
  productPolicy?: ProductPolicy;
  /** CANCELLATION_CHARGE rule amount for this service/category/city (0 = none configured). */
  cancellationCharge?: number;
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

// Service cancellations whose charge comes from the configurable CANCELLATION_CHARGE rule
// (CommissionRule ruleType, by service/category/city) — never a hardcoded amount.
const CANCELLATION_ISSUES: SupportIssueType[] = ['PARTNER_ON_THE_WAY', 'PARTNER_ARRIVED', 'CUSTOMER_REFUSED_SERVICE'];
const OPEN_CASE_STATUSES: SupportCaseStatus[] = ['OPEN', 'IN_REVIEW', 'WAITING_CUSTOMER', 'WAITING_PARTNER', 'DISPUTE', 'ADMIN_REVIEW'];
// Service cases an admin settles by cancelling, reassigning, continuing the service or refunding.
const SERVICE_REVIEW_ISSUES: SupportIssueType[] = [...CANCELLATION_ISSUES, 'SERVICE_STARTED_ISSUE'];
// The customer shared the START OTP (Order.startOtpVerified) — the work has begun.
const SERVICE_STARTED_STATUSES = ['STARTED', 'EXTRA_WORK_ADDED', 'IN_PROGRESS'];
const ORDER_CLOSED_STATUSES = ['COMPLETED', 'INVOICED', 'CLOSED', 'CANCELLED', 'REFUNDED'];
const ACTIVE_REFUND_STATUSES = ['REQUESTED', 'PARTNER_RESPONDED', 'UNDER_REVIEW', 'ESCALATED']; // undecided
const SERVICE_STARTED_MESSAGE = 'The service has already started (you shared the start OTP), so it can no longer be cancelled here. If something is wrong, please raise a complaint — our team will review it.';
const serviceStarted = (o: { startOtpVerified?: boolean | null; status: string }) => !!o.startOtpVerified || SERVICE_STARTED_STATUSES.includes(o.status);

export const REFUSAL_REASONS = ['CUSTOMER_REFUSED', 'CUSTOMER_CHANGED_MIND', 'PRICE_DISAGREEMENT', 'SITE_NOT_READY', 'WORK_DIFFERENT_FROM_BOOKING', 'OTHER'] as const;
const REFUSAL_REASON_LABELS: Record<(typeof REFUSAL_REASONS)[number], string> = {
  CUSTOMER_REFUSED: 'Customer refused the service',
  CUSTOMER_CHANGED_MIND: 'Customer changed their mind',
  PRICE_DISAGREEMENT: 'Customer disagreed with the price',
  SITE_NOT_READY: 'Site not ready for the work',
  WORK_DIFFERENT_FROM_BOOKING: 'Work differs from what was booked',
  OTHER: 'Other',
};

/** Partner, after arriving: the customer refused the service. Location fields as for arrival. */
export class PartnerRefusalDto {
  @IsIn(REFUSAL_REASONS as unknown as string[]) reasonCode: (typeof REFUSAL_REASONS)[number];
  @IsOptional() @IsString() @MaxLength(1000) remarks?: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsNumber() @Min(0) accuracyM?: number;
  @IsOptional() @IsString() @MaxLength(200) locationError?: string;
}
export class CustomerStatementDto {
  @IsString() @MaxLength(1000) statement: string;
}
export class CancellationRequestDto {
  @IsString() @MaxLength(1000) reason: string;
}
export class AdminDecideDto {
  @IsString() resolutionType: SupportResolutionType;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsString() @MaxLength(2000) reason: string;
  @IsOptional() @IsString() newVendorId?: string;
  @IsOptional() @IsNumber() @Min(0) partnerCompensation?: number;
  @IsOptional() @IsBoolean() cancelOrder?: boolean;
  // Recovery FROM the partner (separate ledger debit) — only for a job the partner was paid for.
  @IsOptional() @IsNumber() @Min(0) partnerRecovery?: number;
  // Cancellation penalty the admin approves (≤ the configured rule for the service/city).
  @IsOptional() @IsNumber() @Min(0) penaltyAmount?: number;
}

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
  //
  // Phase 6 fix: this used to branch on `!order.vendorId` alone — vendorId is the ServiceVendor
  // FK, which is ALWAYS null for a PRODUCT order (product attribution lives on
  // OrderItem.vendorId/Product.vendorId, never Order.vendorId). That meant every product order,
  // delivered or not, fell into the same "NOT_ASSIGNED" bucket forever — RETURN_PRODUCT could
  // never be offered (getIssueOptions only adds it at stage COMPLETED) and CANCEL_PRODUCT was
  // offered forever (see the CANCEL_PRODUCT dead-code fix in recommend() below). PRODUCT orders
  // now get their own real stage derivation, reading Order.type/productFulfillmentStage instead.
  deriveServiceStage(order: {
    status: string; vendorId: string | null; type?: string; productFulfillmentStage?: string | null; items?: unknown[];
  }): ServiceStage {
    const isProduct = order.type === 'PRODUCT' || (order.items?.length ?? 0) > 0;
    if (isProduct) {
      if (order.status === 'CANCELLED' || order.status === 'REFUNDED') return 'CLOSED';
      if (order.status === 'COMPLETED') return 'COMPLETED';
      switch (order.productFulfillmentStage) {
        case 'SELLER_ACCEPTED':
        case 'PROCESSING': return 'ASSIGNED';
        case 'READY_FOR_PICKUP':
        case 'HANDED_TO_LOGISTICS': return 'EN_ROUTE';
        case 'SELLER_REJECTED': return 'CLOSED';
        default: return 'NOT_ASSIGNED'; // null (pre-Phase-5 order) or AWAITING_SELLER
      }
    }
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

  // Phase 6 — `productPolicy` gates the two policy-sensitive options: RETURN_PRODUCT only when
  // the product is actually returnable, WARRANTY_CLAIM only when it's warranty-eligible.
  // Optional so every pre-existing SERVICE call site (which never has a productPolicy) is
  // unaffected.
  getIssueOptions(itemType: SupportItemType, stage: ServiceStage, productPolicy?: ProductPolicy): SupportIssueType[] {
    if (itemType === 'PRODUCT') {
      const opts: SupportIssueType[] = [];
      if (stage !== 'COMPLETED' && stage !== 'CLOSED') opts.push('NOT_DELIVERED', 'DELIVERED_LATE');
      opts.push('WRONG_PRODUCT', 'DAMAGED_PRODUCT', 'MISSING_ITEM');
      if (stage === 'PENDING' || stage === 'NOT_ASSIGNED') opts.push('CANCEL_PRODUCT');
      if (stage === 'COMPLETED' && productPolicy?.returnable !== false) opts.push('RETURN_PRODUCT');
      if (stage === 'COMPLETED' && productPolicy?.warrantyAvailable) opts.push('WARRANTY_CLAIM');
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
    const { itemType, issueType, order, amountBasis, policy, warranty, productPolicy } = input;
    // A product with neither return nor replacement allowed can never auto-resolve into a
    // physical pickup — business rule: route to a policy-explaining response instead, pointing
    // the customer at Warranty when the product has one configured.
    const returnBlocked = productPolicy != null && productPolicy.returnable === false && productPolicy.replaceable === false;

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
          if (returnBlocked) {
            return {
              routeType: 'SUPPORT_CASE', resolutionType: 'NO_REFUND', amount: null,
              reasonForCustomer: productPolicy?.warrantyAvailable
                ? 'This product is not eligible for return or replacement, but it does carry a warranty — please raise a Warranty claim instead.'
                : 'This product is marked non-returnable and non-replaceable. Our team will review your report manually.',
              policyApplied: 'Product after-sales policy: return and replacement both disabled for this product.',
            };
          }
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
          // Phase 6 dead-code fix: VENDOR_ASSIGNED is a SERVICE-only OrderStatus value —
          // product attribution is OrderItem.vendorId, never Order.vendorId, so a PRODUCT
          // order's Order.status can never actually become VENDOR_ASSIGNED. This check was
          // inherited from the SERVICE branch's shape and never actually matched anything.
          const cancellable = ['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status);
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
          if (returnBlocked) {
            return {
              routeType: 'SUPPORT_CASE', resolutionType: 'NO_REFUND', amount: null,
              reasonForCustomer: productPolicy?.warrantyAvailable
                ? 'This product is not eligible for return or replacement, but it does carry a warranty — please raise a Warranty claim instead.'
                : 'This product is marked non-returnable and non-replaceable. Our team will review your report manually.',
              policyApplied: 'Product after-sales policy: return and replacement both disabled for this product.',
            };
          }
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
        case 'WARRANTY_CLAIM':
          // Only reachable when getIssueOptions() already gated on productPolicy.warrantyAvailable
          // — no separate check needed here. Opens a WarrantyCase instead of moving money; the
          // seller reviews and recommends, admin makes the final call (see WarrantyService).
          return {
            routeType: 'AUTO_RESOLUTION', resolutionType: 'WARRANTY_CLAIM_OPENED', amount: null,
            reasonForCustomer: 'Your warranty claim has been raised. The seller will review it, and our team will confirm the resolution.',
            policyApplied: productPolicy?.warrantyAvailable ? 'Warranty available for this product.' : 'Warranty claim.',
          };
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
      // Cancellation charges come only from the CANCELLATION_CHARGE rule (service/category/
      // city, admin-configured; none = ₹0) — never a hardcoded amount — and are NEVER deducted
      // automatically: a configured charge always routes to admin review first.
      case 'PARTNER_ON_THE_WAY':
        // Before arrival no penalty applies — but a request alone never moves money: an admin
        // confirms the cancellation and approves the refund.
        return {
          routeType: 'SUPPORT_CASE', resolutionType: 'FULL_REFUND', amount: money(amountBasis),
          reasonForCustomer: 'Your partner had not arrived yet, so no cancellation penalty applies. Our team will confirm the cancellation and your refund shortly.',
          policyApplied: 'Before arrival: no cancellation penalty. Cancellation and refund are confirmed by an admin.',
        };
      case 'PARTNER_ARRIVED':
      case 'CUSTOMER_REFUSED_SERVICE': {
        const charge = Math.max(0, input.cancellationCharge || 0);
        return {
          routeType: 'SUPPORT_CASE',
          resolutionType: charge > 0 ? 'REFUND_MINUS_VISIT' : 'FULL_REFUND',
          amount: Math.max(0, money(amountBasis - charge)),
          reasonForCustomer: issueType === 'CUSTOMER_REFUSED_SERVICE'
            ? 'Your partner reported that the service could not go ahead at your address. Our team will review the details, including your side, before deciding anything. No charge is applied until then.'
            : 'Your partner had already arrived, so our team will review this cancellation before deciding any charge. Nothing is deducted until then.',
          policyApplied: charge > 0
            ? `Configured cancellation charge for this service/city: ₹${charge} — applies only if an admin approves it.`
            : 'No cancellation charge is configured for this service/city.',
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
    private warranty: WarrantyService,
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

  /**
   * For service cancellations: the configured CANCELLATION_CHARGE (service/category/city rule,
   * 0 if none) and the amount the customer actually PAID — the refund basis. Refunding
   * order.totalAmount would credit money never collected on an unpaid cash-on-service order.
   */
  private async cancellationContext(order: {
    id: string; customerId: string; masterOrderId?: string | null; addressId?: string | null;
    serviceId?: string | null; service?: { id: string; categoryId: string } | null; snapshotCity?: string | null;
    paymentStatus?: string | null; totalAmount: any; walletUsed?: any; serviceAmount?: any;
  }, client: any = this.prisma) {
    // Money actually received and everything committed against it by EVERY refund route
    // (completed refunds + outstanding reservations) — the same boundary RefundsService enforces.
    const state = await this.refunds.bookingRefundState(client, { orderId: order.id });
    const bookingTotal = money(Number(order.totalAmount || 0) + Number(order.walletUsed || 0));
    // Penalty: the booking's city (snapshot, else the customer's own address) — never another city's rule.
    const cityId = await resolveCityIdForRules(client, { cityName: order.snapshotCity, addressId: order.addressId, customerId: order.customerId });
    const penalty = order.service
      ? await resolveCancellationPenalty(client, { serviceId: order.service.id, categoryId: order.service.categoryId, cityId, serviceAmount: Number(order.serviceAmount || 0), cap: bookingTotal })
      : { penalty: 0, ruleId: null, label: 'No cancellation penalty configured', breakdown: { percent: null, percentAmount: null, minimum: null, cap: bookingTotal, capped: false } };
    return {
      charge: penalty.penalty, penalty, paid: state.received, bookingTotal,
      alreadyRefunded: state.committed, inFlight: state.inFlight, refundable: state.refundable,
    };
  }

  /**
   * Claims a case's refund amount (compare-and-swap on refundedTotal) so two decisions on the SAME
   * case can never both raise a refund. The booking-wide limit across every route and case is
   * enforced atomically by RefundsService.decide() under the shared booking lock.
   */
  private async claimCaseRefund(caseId: string, total: number): Promise<{ prior: number; delta: number }> {
    const kase = await this.prisma.supportCase.findUnique({ where: { id: caseId }, select: { refundedTotal: true } });
    const prior = money(Number(kase?.refundedTotal || 0));
    const delta = money(total - prior);
    if (delta <= 0) return { prior, delta: 0 };
    const c = await this.prisma.supportCase.updateMany({ where: { id: caseId, refundedTotal: prior }, data: { refundedTotal: money(prior + delta) } });
    if (c.count !== 1) throw new ConflictException('A refund for this case is already being processed — reload the case');
    return { prior, delta };
  }

  /**
   * Creates a support case. With `oncePer`, at most one OPEN case may exist for that order and
   * issue: the check and the insert run in ONE transaction holding a Postgres advisory lock keyed
   * on order+issue, so simultaneous submits serialise and the later one gets the case the first
   * created. No schema change; every query runs on the transaction's own connection.
   */
  private async createCase(
    oncePer: { orderId: string; issueType: SupportIssueType } | null,
    build: (caseNumber: string) => any,
  ): Promise<{ kase: any; existing: boolean }> {
    if (!oncePer) {
      return { kase: await this.prisma.supportCase.create({ data: build(await this.nextCaseNumber()) }), existing: false };
    }
    return this.prisma.$transaction(async (tx) => {
      const lockKey = `support-case-open:${oncePer.orderId}:${oncePer.issueType}`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const open = await tx.supportCase.findFirst({
        where: { orderId: oncePer.orderId, issueType: oncePer.issueType, status: { in: OPEN_CASE_STATUSES } },
      });
      if (open) return { kase: open, existing: true };
      const count = await tx.supportCase.count();
      const kase = await tx.supportCase.create({ data: build(`SUP-${(count + 1).toString().padStart(6, '0')}`) });
      return { kase, existing: false };
    }, { timeout: 15000, maxWait: 10000 });
  }

  private async loadOrderForCase(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      // Phase 6 — items.product included so getContext()/openCase() can build a per-product
      // after-sales policy snapshot (Product.returnable/replaceable/warrantyAvailable/etc.).
      include: { items: { include: { product: true } }, service: { include: { category: true } } },
    });
  }

  // Phase 6 — builds the ProductPolicy snapshot SupportPolicyEngine needs, from whichever
  // product the case concerns (the specific orderItem's product if scoped, else the order's
  // first item — matches the existing item-level-scoping convention elsewhere in this file).
  private productPolicyFor(order: { items: { id: string; product: { returnable: boolean; replaceable: boolean; warrantyAvailable: boolean } | null }[] }, orderItem: { id: string } | null) {
    const item = orderItem ? order.items.find((i) => i.id === orderItem.id) : order.items[0];
    const product = item?.product;
    if (!product) return undefined;
    return { returnable: product.returnable, replaceable: product.replaceable, warrantyAvailable: product.warrantyAvailable };
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
    const productPolicy = itemType === 'PRODUCT' ? this.productPolicyFor(order, orderItem) : undefined;
    const issueOptions = this.policyEngine.getIssueOptions(itemType, stage, productPolicy);
    const result: any = {
      itemType, stage, issueOptions,
      // Phase 6 — frontend gate: disable Submit until at least one evidence photo is attached
      // when the concerned product requires it (Product.evidencePhotoRequired).
      evidenceRequired: itemType === 'PRODUCT' ? (order.items.find((i) => (orderItem ? i.id === orderItem.id : true))?.product?.evidencePhotoRequired ?? true) : false,
    };

    if (issueType) {
      let amountBasis = orderItem ? Number(orderItem.totalPrice) : Number(order.totalAmount);
      let cancellationCharge: number | undefined;
      if (itemType === 'SERVICE' && CANCELLATION_ISSUES.includes(issueType)) {
        const c = await this.cancellationContext(order);
        amountBasis = c.refundable; cancellationCharge = c.charge;
      }
      const policy = await this.policyEngine.getPolicyConfig();
      const warranty = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
      result.recommendation = this.policyEngine.recommend({ itemType, issueType, order, amountBasis, policy, warranty, productPolicy, cancellationCharge });
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
    let amountBasis = orderItem ? Number(orderItem.totalPrice) : Number(order.totalAmount);
    let cancellationCharge: number | undefined;
    if (itemType === 'SERVICE' && CANCELLATION_ISSUES.includes(dto.issueType) && serviceStarted(order)) {
      throw new ConflictException({ error: 'SERVICE_STARTED', message: SERVICE_STARTED_MESSAGE });
    }
    if (itemType === 'SERVICE' && CANCELLATION_ISSUES.includes(dto.issueType)) {
      // At most one open cancellation case per order and issue — a repeat submit returns it.
      const existingOpen = await this.prisma.supportCase.findFirst({
        where: { orderId: order.id, issueType: dto.issueType, status: { in: OPEN_CASE_STATUSES } },
      });
      if (existingOpen) return existingOpen;
      const c = await this.cancellationContext(order);
      amountBasis = c.refundable; cancellationCharge = c.charge;
    }
    const policy = await this.policyEngine.getPolicyConfig();
    const warranty = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
    const productPolicy = itemType === 'PRODUCT' ? this.productPolicyFor(order, orderItem) : undefined;
    const rec = this.policyEngine.recommend({ itemType, issueType: dto.issueType, order, amountBasis, policy, warranty, productPolicy, cancellationCharge });

    const isCancellationCase = itemType === 'SERVICE' && CANCELLATION_ISSUES.includes(dto.issueType);
    const { kase: created, existing } = await this.createCase(
      isCancellationCase ? { orderId: order.id, issueType: dto.issueType } : null,
      (caseNumber) => ({
        caseNumber, orderId: order.id, orderItemId: orderItem?.id, customerId,
        partnerId: order.vendorId || undefined,
        itemType, issueType: dto.issueType, description: dto.description,
        evidenceUrls: dto.evidenceUrls || [],
        requestedRemedy: dto.requestedRemedy,
        statusSnapshot: order.status,
        openedByRole: 'CUSTOMER',
        status: rec.routeType === 'DISPUTE' ? 'DISPUTE' : 'OPEN',
        routeType: rec.routeType,
        recommendedResolution: rec.resolutionType ?? undefined,
        recommendedAmount: rec.amount ?? undefined,
        recommendationReason: rec.reasonForCustomer,
        policyApplied: rec.policyApplied,
      }),
    );
    if (existing) return created; // a simultaneous submit already opened it
    const caseNumber = created.caseNumber;
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

  /**
   * Partner, at the customer's address: the customer refused the service. Records the arrival
   * evidence (fresh location, server-verified, recorded once) and opens an ADMIN_REVIEW case.
   * The partner's word alone never confirms customer fault and nothing moves money here.
   */
  async partnerReportRefusal(vendorUserId: string, orderId: string, dto: PartnerRefusalDto) {
    const v = await this.prisma.serviceVendor.findUnique({ where: { userId: vendorUserId } });
    if (!v) throw new ForbiddenException();
    const order = await this.loadOrderForCase(orderId);
    if (!order || order.vendorId !== v.id) throw new ForbiddenException();
    if (order.items.length > 0) throw new BadRequestException('Only service jobs can be reported this way');
    if (!['VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE'].includes(order.status)) {
      throw new BadRequestException('A refusal can only be reported before the job starts');
    }
    if (dto.reasonCode === 'OTHER' && !dto.remarks?.trim()) throw new BadRequestException('Please add remarks for "Other"');

    const existingOpen = await this.prisma.supportCase.findFirst({
      where: { orderId: order.id, issueType: 'CUSTOMER_REFUSED_SERVICE', status: { in: OPEN_CASE_STATUSES } },
    });
    if (existingOpen) return existingOpen;

    const arrival = await recordPartnerArrival(this.prisma, order, dto, { vendorId: v.id });
    const { charge, refundable } = await this.cancellationContext(order);
    const policy = await this.policyEngine.getPolicyConfig();
    const warranty = await this.ledger.getWarrantyDefaults(order.service?.category ?? null);
    const rec = this.policyEngine.recommend({
      itemType: 'SERVICE', issueType: 'CUSTOMER_REFUSED_SERVICE', order, amountBasis: refundable, policy, warranty, cancellationCharge: charge,
    });
    const remarks = dto.remarks?.trim() || '';
    const { kase: created, existing } = await this.createCase(
      { orderId: order.id, issueType: 'CUSTOMER_REFUSED_SERVICE' },
      (caseNumber) => ({
        caseNumber, orderId: order.id, customerId: order.customerId, partnerId: v.id,
        itemType: 'SERVICE', issueType: 'CUSTOMER_REFUSED_SERVICE',
        description: `${REFUSAL_REASON_LABELS[dto.reasonCode]}${remarks ? ' — ' + remarks : ''}`,
        evidenceUrls: [],
        statusSnapshot: order.status,
        openedByRole: 'SERVICE_VENDOR',
        status: 'ADMIN_REVIEW',
        routeType: 'SUPPORT_CASE',
        partnerResponse: remarks || REFUSAL_REASON_LABELS[dto.reasonCode],
        partnerRespondedAt: new Date(),
        recommendedResolution: rec.resolutionType ?? undefined,
        recommendedAmount: rec.amount ?? undefined,
        recommendationReason: rec.reasonForCustomer,
        policyApplied: rec.policyApplied,
      }),
    );
    if (existing) return created; // a simultaneous report already opened it
    const caseNumber = created.caseNumber;
    await this.log(created.id, vendorUserId, UserRole.SERVICE_VENDOR, 'OPENED_BY_PARTNER',
      `${dto.reasonCode}${remarks ? ': ' + remarks : ''} | arrival ${arrival.arrival.arrivalVerification}${arrival.arrival.arrivalDistanceM != null ? ' (' + arrival.arrival.arrivalDistanceM + ' m)' : ''}`);
    await this.notifications.create(order.customerId, {
      title: 'Your partner reported an issue at your address',
      body: `Case ${caseNumber}: the partner reported the service could not go ahead. Our team will review — you can add your side from your bookings.`,
      channels: [NotificationChannel.IN_APP],
      orderId: order.id,
    }).catch(() => {});
    return created;
  }

  /** Customer asks to cancel after the partner arrived/started — opens a review case (no instant cancel). */
  async requestCancellation(customerId: string, orderId: string, reason: string) {
    const order = await this.loadOrderForCase(orderId);
    if (!order || order.customerId !== customerId) throw new ForbiddenException();
    if (order.items.length > 0) throw new BadRequestException('Product orders use the normal cancel/return flow');
    if (ORDER_CLOSED_STATUSES.includes(order.status)) {
      throw new BadRequestException('This booking can no longer be cancelled');
    }
    if (serviceStarted(order)) throw new ConflictException({ error: 'SERVICE_STARTED', message: SERVICE_STARTED_MESSAGE });
    if (!order.arrivedAt) {
      throw new BadRequestException('Your partner has not arrived yet — you can cancel this booking directly');
    }
    return this.openCase(customerId, { orderId, issueType: 'PARTNER_ARRIVED', description: `Cancellation requested: ${reason}` });
  }

  /** Customer's side / dispute of a proposed charge, before the admin decides. */
  async customerRespond(customerId: string, caseId: string, statement: string) {
    const kase = await this.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!kase || kase.customerId !== customerId) throw new ForbiddenException();
    if (!OPEN_CASE_STATUSES.includes(kase.status)) throw new BadRequestException('This case is no longer open — you can appeal the decision instead');
    if (!statement?.trim()) throw new BadRequestException('Please write your response');
    const updated = await this.prisma.supportCase.update({
      where: { id: caseId },
      data: { customerStatement: statement.trim(), status: kase.status === 'WAITING_CUSTOMER' ? 'ADMIN_REVIEW' : kase.status },
    });
    await this.log(caseId, customerId, UserRole.CUSTOMER, 'CUSTOMER_STATEMENT', statement.trim());
    return updated;
  }

  /** One appeal of a decided cancellation case — back to admin review (claimed atomically). */
  async customerAppeal(customerId: string, caseId: string, statement: string) {
    const kase = await this.prisma.supportCase.findUnique({ where: { id: caseId } });
    if (!kase || kase.customerId !== customerId) throw new ForbiddenException();
    if (!CANCELLATION_ISSUES.includes(kase.issueType)) throw new BadRequestException('Only cancellation decisions can be appealed here');
    if (!statement?.trim()) throw new BadRequestException('Please explain your appeal');
    const claimed = await this.prisma.supportCase.updateMany({
      where: { id: caseId, status: 'RESOLVED', appealedAt: null },
      data: { appealStatement: statement.trim(), appealedAt: new Date(), status: 'ADMIN_REVIEW', closedAt: null },
    });
    if (claimed.count !== 1) throw new BadRequestException('This decision cannot be appealed (already appealed, or not decided yet)');
    await this.log(caseId, customerId, UserRole.CUSTOMER, 'APPEALED', statement.trim());
    return this.prisma.supportCase.findUnique({ where: { id: caseId } });
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
      // `amount` is the TOTAL the customer should get back for this case; anything already
      // refunded (a decision before an appeal) is subtracted, so a case never refunds twice.
      const { prior, delta } = await this.claimCaseRefund(caseId, amount);
      if (delta > 0) {
        let rr: { id: string };
        try {
          const description = `Support case ${kase.caseNumber} (${kase.issueType}): ${reason}`;
          // The wallet portion of an unpaid (cash) booking is refundable from a service case.
          const payment = kase.itemType === 'SERVICE'
            ? await this.prisma.order.findUnique({ where: { id: kase.orderId }, select: { paymentStatus: true, walletUsed: true } })
            : null;
          const walletPortionOnly = !!payment && !['PAID', 'PARTIAL'].includes(payment.paymentStatus) && Number(payment.walletUsed || 0) > 0;
          // Tagged with the case: its amount is tracked on the case and the partner is never
          // auto-charged for it (any recovery is a separate admin decision).
          rr = await this.refunds.raise(kase.customerId, kase.orderId, undefined, description, kase.evidenceUrls, { allowWalletPortion: walletPortionOnly, supportCaseId: caseId });
        } catch (e) {
          // Nothing was refunded — release the claim so the decision can be retried.
          await this.prisma.supportCase.updateMany({ where: { id: caseId, refundedTotal: money(prior + delta) }, data: { refundedTotal: prior } });
          throw e;
        }
        refundRequestId = rr.id;
        await this.prisma.supportCase.update({ where: { id: caseId }, data: { refundRequestId: rr.id } });
        try {
          // Default is WALLET_CREDIT per the same business rule RefundsService itself documents —
          // this module never picks a gateway refund; an admin who wants that opens the
          // RefundRequest directly via the existing Refunds admin screen.
          await this.refunds.decide(actorId || 'SYSTEM', rr.id, 'WALLET_CREDIT', { approvedAmount: delta, adminNotes: reason });
        } catch (e) {
          if (e instanceof RefundCapacityExceeded) {
            // Refused BEFORE any money moved (another route/case used the booking's limit first):
            // release this case's claim and withdraw the undecided request.
            await this.prisma.supportCase.updateMany({ where: { id: caseId, refundedTotal: money(prior + delta) }, data: { refundedTotal: prior } });
            await this.refunds.withdrawUndecided(rr.id, `Withdrawn — ${(e as Error).message}`);
            throw e;
          }
          // Money may or may not have moved, so the claim is KEPT (fail closed: this case will
          // never raise a second refund). The request stays open in Admin › Refunds, whose own
          // atomic claim lets it be completed exactly once.
          await this.log(caseId, actorId ?? undefined, actorId ? UserRole.ADMIN : undefined, 'REFUND_NEEDS_ATTENTION', `Refund request ${rr.id} (₹${delta}) failed: ${(e as Error).message}`);
          throw new ConflictException(`The refund could not be completed automatically — finish refund request ${rr.id} from Admin › Refunds. This case will not issue it again.`);
        }
      }
    } else if (resolutionType === 'REASSIGN_PARTNER') {
      if (!actorId) throw new BadRequestException('Reassigning a partner requires admin review');
      if (!opts?.newVendorId) throw new BadRequestException('newVendorId is required to reassign a partner');
      await this.admin.forceAssignVendor(kase.orderId, opts.newVendorId, actorId, UserRole.ADMIN);
    } else if (resolutionType === 'RETURN_PICKUP_INITIATED') {
      // Phase 5 — schedules the physical pickup instead of moving money; the case stays open
      // (IN_REVIEW, not RESOLVED) until the seller's inspection accepts/rejects the item and
      // ReturnsService.finalize() closes it out for real.
      await this.returns.initiate(kase.id, kase.orderId, actorId || undefined);
    } else if (resolutionType === 'WARRANTY_CLAIM_OPENED') {
      // Phase 6 — opens a WarrantyCase instead of moving money; same "stays open until a real
      // decision lands" pattern as RETURN_PICKUP_INITIATED above.
      const item = kase.orderItemId
        ? await this.prisma.orderItem.findUnique({ where: { id: kase.orderItemId }, select: { productId: true } })
        : await this.prisma.orderItem.findFirst({ where: { orderId: kase.orderId }, select: { productId: true } });
      await this.warranty.openCase(kase.id, kase.orderId, item?.productId, kase.customerId, kase.orderItemId ?? undefined);
    }
    // NO_REFUND / FREE_REVISIT / FREE_REWORK / NEW_SERVICE_REQUIRED / CUSTOMER_PAYABLE /
    // PARTNER_LIABILITY / SPLIT_LIABILITY are recorded on the case only — there is no existing
    // "charge the customer more" or "penalize the vendor beyond their warranty hold" system to
    // call, and this module does not invent one (see plan doc). Admin can follow up manually
    // (e.g. the existing AdminService.postLedgerAdjustment for a vendor-side consequence).

    const staysOpen = resolutionType === 'RETURN_PICKUP_INITIATED' || resolutionType === 'WARRANTY_CLAIM_OPENED';
    const isReturnPickup = staysOpen; // preserves the existing variable name used below
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
    const logAction = resolutionType === 'WARRANTY_CLAIM_OPENED' ? 'WARRANTY_CASE_OPENED' : isReturnPickup ? 'RETURN_PICKUP_SCHEDULED' : 'RESOLVED';
    await this.log(caseId, actorId ?? undefined, actorId ? UserRole.ADMIN : undefined, logAction, `${resolutionType ?? 'REVIEWED'}: ${reason}`);
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
    amount: number | undefined, reason: string, opts?: { newVendorId?: string; partnerCompensation?: number; cancelOrder?: boolean; partnerRecovery?: number; penaltyAmount?: number },
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
    // Phase 6 — same reasoning as the return-pickup guard above: a warranty claim must be
    // closed out via the seller's recommendation + admin's warranty-specific decision, not
    // re-decided generically here.
    if (kase.resolutionType === 'WARRANTY_CLAIM_OPENED') {
      throw new BadRequestException('This warranty claim is awaiting seller/admin review — decide it from the Warranty Cases queue instead');
    }
    // Service review cases (cancellation requests, partner-reported refusals, issues during the
    // service): the admin cancels the booking, reassigns, continues the service or refunds. Every
    // money step is validated BEFORE anything moves and kept separate — customer refund, partner
    // compensation (credit) and partner recovery (debit) are distinct, individually traceable entries.
    const compensation = money(Number(opts?.partnerCompensation || 0));
    const recovery = money(Number(opts?.partnerRecovery || 0));
    const penalty = money(Number(opts?.penaltyAmount || 0));
    const refundRequested = REFUND_RESOLUTIONS.includes(resolutionType) && (amount ?? 0) > 0;
    if (SERVICE_REVIEW_ISSUES.includes(kase.issueType)) {
      const order = await this.loadOrderForCase(kase.orderId);
      if (!order) throw new NotFoundException('Order not found');
      if (opts?.cancelOrder && resolutionType === 'REASSIGN_PARTNER') {
        throw new BadRequestException('Choose one: cancel the booking, or reassign it to another partner');
      }
      // Workflow: on a cancellation request a refund becomes available only once the booking is
      // cancelled (in this decision or earlier) — "continue" or "reassign" never refunds.
      if (refundRequested && CANCELLATION_ISSUES.includes(kase.issueType) && !opts?.cancelOrder && order.status !== 'CANCELLED') {
        throw new BadRequestException('Approve the cancellation first — on a cancellation request a refund is only available once the booking is cancelled');
      }
      if (refundRequested) {
        const { paid, alreadyRefunded, refundable } = await this.cancellationContext(order);
        const refundNow = money((amount ?? 0) - Number(kase.refundedTotal || 0));
        if (refundNow > refundable) {
          throw new BadRequestException(`This decision would refund ₹${refundNow} more, but only ₹${refundable} is still refundable (paid ₹${paid}, already refunded ₹${alreadyRefunded})`);
        }
      }
      if (compensation > 0) {
        if (!kase.partnerId) throw new BadRequestException('This case has no partner to compensate');
        if (kase.partnerCompensatedAt && money(Number(kase.partnerCompensation)) !== compensation) {
          throw new BadRequestException(`Partner compensation of ₹${Number(kase.partnerCompensation)} was already applied for this case`);
        }
        if (compensation > Number(order.totalAmount)) throw new BadRequestException('Compensation cannot exceed the booking amount');
      }
      if (recovery > 0) this.validatePartnerRecovery(kase, order, recovery);
      if (penalty > 0) {
        // Only the configured rule for this service/city, only after arrival, only when cancelling.
        if (!['PARTNER_ARRIVED', 'CUSTOMER_REFUSED_SERVICE'].includes(kase.issueType) || !order.arrivedAt) {
          throw new BadRequestException('A cancellation penalty applies only when the customer cancels after the partner has arrived');
        }
        if (!opts?.cancelOrder && order.status !== 'CANCELLED') throw new BadRequestException('A cancellation penalty applies only when the booking is cancelled');
        const { penalty: configured } = await this.cancellationContext(order);
        if (!(configured.penalty > 0)) throw new BadRequestException('No cancellation penalty is configured for this service and city');
        if (penalty > configured.penalty) throw new BadRequestException(`The penalty cannot exceed the configured ₹${configured.penalty} (${configured.label})`);
      }
    } else if (penalty > 0) {
      throw new BadRequestException('A cancellation penalty applies only to cancellation cases');
    } else if (compensation > 0 || opts?.cancelOrder) {
      throw new BadRequestException('Compensation and cancellation apply only to service review cases');
    } else if (recovery > 0) {
      // A completed job the customer says was not fixed: the partner WAS paid, so an admin may
      // record a recovery — never automatic, always its own ledger entry.
      if (kase.issueType !== 'SERVICE_COMPLETED_ISSUE_NOT_FIXED') throw new BadRequestException('Partner recovery applies only to service cases');
      const order = await this.loadOrderForCase(kase.orderId);
      if (!order) throw new NotFoundException('Order not found');
      this.validatePartnerRecovery(kase, order, recovery);
    }

    // One decision at a time: atomically move the case out of its open state (CLOSED here means
    // "decision in progress"; executeResolution() then sets RESOLVED). A concurrent or repeated
    // decide() fails this claim before ANY side effect. Every step below is itself idempotent, so
    // after a failure the case is re-opened and a retry completes only what is left.
    const claimed = await this.prisma.supportCase.updateMany({ where: { id: caseId, status: kase.status }, data: { status: 'CLOSED' } });
    if (claimed.count !== 1) throw new ConflictException('This case is being decided by someone else or has just changed — reload it');
    try {
      // Order of steps = the approved workflow: partner ledger decisions, then the cancellation,
      // then (only after it) the customer refund.
      if (compensation > 0) await this.compensatePartnerOnce(kase, compensation, reason, adminId);
      if (recovery > 0) await this.recoverFromPartnerOnce(kase, recovery, reason, adminId);
      if (opts?.cancelOrder) await this.cancelOrderOnce(kase, reason, adminId);
      await this.executeResolution(caseId, resolutionType, amount ?? null, reason, adminId, opts);
    } catch (e) {
      await this.prisma.supportCase.updateMany({ where: { id: caseId, status: 'CLOSED' }, data: { status: kase.status } }).catch(() => {});
      throw e;
    }
    if (penalty > 0) await this.recordPenalty(kase, penalty, adminId);
    return this.prisma.supportCase.findUnique({ where: { id: caseId } });
  }

  /**
   * Records the admin-approved cancellation penalty AFTER the decision: the part covered by money
   * actually received and not refunded is "retained"; the rest is only "pending collection" — never
   * charged automatically and not collected revenue. Records only; no money moves here. (GST/tax
   * treatment of the penalty is unchanged pending CA confirmation.)
   */
  private async recordPenalty(kase: { id: string; orderId: string }, penalty: number, adminId: string) {
    const state = await this.refunds.bookingRefundState(this.prisma, { orderId: kase.orderId });
    const retained = money(Math.min(penalty, state.refundable));
    const pending = money(penalty - retained);
    await this.prisma.supportCase.update({
      where: { id: kase.id },
      data: { penaltyAssessed: penalty, penaltyRetained: retained, penaltyPendingCollection: pending, penaltyAssessedAt: new Date() },
    });
    await this.log(kase.id, adminId, UserRole.ADMIN, 'PENALTY_ASSESSED', `₹${penalty}: ₹${retained} retained from payment, ₹${pending} pending collection (not charged)`);
    await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'CANCELLATION_PENALTY_ASSESSED', targetType: 'SupportCase', targetId: kase.id, metadata: { penalty, retained, pending } });
  }

  /** A partner is never charged for money that was never paid to them, nor more than they were paid. */
  private validatePartnerRecovery(
    kase: { partnerId: string | null; partnerRecoveredAt: Date | null; partnerRecovery: any },
    order: { completedAt?: Date | null; status: string; vendorPayout?: any }, recovery: number,
  ) {
    if (!kase.partnerId) throw new BadRequestException('This case has no partner to recover from');
    const paidOut = !!order.completedAt || ['COMPLETED', 'INVOICED', 'CLOSED'].includes(order.status);
    if (!paidOut) throw new BadRequestException('The partner was never paid for this booking — there is nothing to recover');
    if (recovery > Number(order.vendorPayout || 0)) throw new BadRequestException(`Recovery cannot exceed the ₹${Number(order.vendorPayout || 0)} paid to the partner for this booking`);
    if (kase.partnerRecoveredAt && money(Number(kase.partnerRecovery)) !== recovery) {
      throw new BadRequestException(`A partner recovery of ₹${Number(kase.partnerRecovery)} was already applied for this case`);
    }
  }

  /** Recovery FROM the partner for a case — the shared, atomic rule (claim + ledger debit + audit
   * in one transaction; never more than the partner earned on the booking across all routes). */
  private async recoverFromPartnerOnce(kase: { id: string; caseNumber: string; orderId: string }, amount: number, reason: string, adminId: string) {
    const res = await this.refunds.recordPartnerRecovery(adminId, {
      source: 'SUPPORT_CASE', sourceId: kase.id, orderId: kase.orderId, amount, reason, sourceLabel: `support case ${kase.caseNumber}`,
    });
    if (res.applied) await this.log(kase.id, adminId, UserRole.ADMIN, 'PARTNER_RECOVERED', `₹${amount}`);
  }

  /** Partner compensation for a case, at most once: claim, post via the existing audited ledger
   * adjustment, and release the claim only if the ledger shows nothing was posted. */
  private async compensatePartnerOnce(kase: { id: string; caseNumber: string; partnerId: string | null }, amount: number, reason: string, adminId: string) {
    const claimed = await this.prisma.supportCase.updateMany({
      where: { id: kase.id, partnerCompensatedAt: null },
      data: { partnerCompensatedAt: new Date(), partnerCompensation: amount },
    });
    if (claimed.count !== 1) return; // already applied (same amount — validated by the caller)
    const note = `Compensation — support case ${kase.caseNumber}: ${reason}`;
    try {
      await this.admin.postLedgerAdjustment(kase.partnerId!, amount, note, adminId);
      await this.log(kase.id, adminId, UserRole.ADMIN, 'PARTNER_COMPENSATED', `₹${amount}`);
    } catch (e) {
      const posted = await this.prisma.partnerLedgerEntry.findFirst({
        where: { vendorId: kase.partnerId!, type: 'ADJUSTMENT', notes: { startsWith: `Compensation — support case ${kase.caseNumber}:` } },
        select: { id: true },
      }).catch(() => ({ id: 'unknown' }));
      if (!posted) await this.prisma.supportCase.updateMany({ where: { id: kase.id }, data: { partnerCompensatedAt: null, partnerCompensation: null } });
      throw e;
    }
  }

  /** Order cancellation for a case, at most once; the claim is released only if the order did not get cancelled. */
  private async cancelOrderOnce(kase: { id: string; caseNumber: string; orderId: string; issueType: SupportIssueType }, reason: string, adminId: string) {
    if (!SERVICE_REVIEW_ISSUES.includes(kase.issueType)) return;
    const claimed = await this.prisma.supportCase.updateMany({ where: { id: kase.id, orderCancelledByCase: false }, data: { orderCancelledByCase: true } });
    if (claimed.count !== 1) return;
    try {
      await this.admin.adminCancelOrder(kase.orderId, `Support case ${kase.caseNumber}: ${reason}`, adminId, UserRole.ADMIN);
      await this.log(kase.id, adminId, UserRole.ADMIN, 'ORDER_CANCELLED', reason);
    } catch (e) {
      const order = await this.prisma.order.findUnique({ where: { id: kase.orderId }, select: { status: true } }).catch(() => null);
      if (order && order.status !== 'CANCELLED') await this.prisma.supportCase.updateMany({ where: { id: kase.id }, data: { orderCancelledByCase: false } });
      throw e;
    }
  }

  /**
   * What cancelling this booking would mean, shown to the customer BEFORE they confirm. An
   * estimate only: after arrival an admin reviews and decides; nothing is deducted until then.
   */
  async cancellationPreview(customerId: string, orderId: string) {
    const order = await this.loadOrderForCase(orderId);
    if (!order || order.customerId !== customerId) throw new ForbiddenException();
    if (order.items.length > 0) throw new BadRequestException('Product orders use the normal cancel/return flow');
    const stage = ORDER_CLOSED_STATUSES.includes(order.status) ? 'CLOSED'
      : serviceStarted(order) ? 'SERVICE_STARTED'
        : order.arrivedAt ? 'PARTNER_ARRIVED' : 'BEFORE_ARRIVAL';
    const ctx = await this.cancellationContext(order);
    const applies = stage === 'PARTNER_ARRIVED';
    const penalty = applies ? ctx.penalty.penalty : 0;
    return {
      stage,
      canCancelDirectly: stage === 'BEFORE_ARRIVAL',
      canRequestCancellation: stage === 'PARTNER_ARRIVED',
      complaintOnly: stage === 'SERVICE_STARTED',
      message: stage === 'SERVICE_STARTED' ? SERVICE_STARTED_MESSAGE : stage === 'CLOSED' ? 'This booking can no longer be cancelled' : undefined,
      bookingTotal: ctx.bookingTotal,
      paid: ctx.paid,
      alreadyRefunded: ctx.alreadyRefunded,
      penalty: applies ? { amount: penalty, rule: ctx.penalty.label, ...ctx.penalty.breakdown } : null,
      // Only money actually received can come back; a penalty above it is never charged automatically.
      estimatedRefund: applies ? money(Math.max(0, ctx.refundable - penalty)) : null,
      note: applies ? 'Estimate only — our team reviews every cancellation after arrival and confirms the final amount. Nothing is deducted until then.' : undefined,
    };
  }

  /**
   * Reconciles a case's refund claim with what was actually refunded — e.g. after a failed
   * automatic refund was completed (possibly for a different amount) or rejected in Admin ›
   * Refunds. Only when none of the case's refund requests is still open; never moves money.
   */
  async reconcileRefundClaim(adminId: string, caseId: string) {
    const found = await this.prisma.supportCase.findUnique({ where: { id: caseId }, select: { orderId: true } });
    if (!found) throw new NotFoundException('Support case not found');
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${'support-case-refund:' + caseId}))`;
      const kase = await tx.supportCase.findUnique({ where: { id: caseId }, select: { refundedTotal: true } });
      const requests = await tx.refundRequest.findMany({ where: { supportCaseId: caseId }, select: { id: true, status: true, claimedAmount: true, approvedAmount: true } });
      const open = requests.find((r: any) => ACTIVE_REFUND_STATUSES.includes(r.status));
      if (open) throw new BadRequestException(`Refund request ${open.id} is still open — complete or reject it in Admin › Refunds first`);
      // Reserved amounts stay counted while a gateway refund is pending / needs attention; a
      // reservation drops only when the provider confirmed a failure (never on a guess).
      const processed = money(requests.reduce((sum: number, r: any) => sum + (Number(r.claimedAmount || 0) > 0 ? Number(r.claimedAmount) : r.status === 'PROCESSED' ? Number(r.approvedAmount || 0) : 0), 0));
      const before = money(Number(kase?.refundedTotal || 0));
      if (before !== processed) await tx.supportCase.update({ where: { id: caseId }, data: { refundedTotal: processed } });
      return { before, after: processed, changed: before !== processed };
    }, { timeout: 15000, maxWait: 10000 });
    if (result.changed) {
      await this.log(caseId, adminId, UserRole.ADMIN, 'REFUND_RECONCILED', `Refund total ${result.before} → ${result.after} (processed refunds)`);
      await logAudit(this.prisma, { actorId: adminId, actorRole: UserRole.ADMIN, action: 'SUPPORT_REFUND_RECONCILED', targetType: 'SupportCase', targetId: caseId, metadata: result });
    }
    return result;
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
      orderIds.length ? this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, arrivedAt: true, arrivalVerification: true, arrivalDistanceM: true } }) : [],
      customerIds.length ? this.prisma.user.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true } }) : [],
      partnerIds.length ? this.prisma.serviceVendor.findMany({ where: { id: { in: partnerIds } }, select: { id: true, fullName: true } }) : [],
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const partnerById = new Map(partners.map((p) => [p.id, p]));
    return cases.map((c) => ({
      ...c,
      orderNumber: orderById.get(c.orderId)?.orderNumber,
      arrivedAt: (orderById.get(c.orderId) as any)?.arrivedAt,
      arrivalVerification: (orderById.get(c.orderId) as any)?.arrivalVerification,
      arrivalDistanceM: (orderById.get(c.orderId) as any)?.arrivalDistanceM,
      customerName: customerById.get(c.customerId)?.name,
      customerPhone: customerById.get(c.customerId)?.phone,
      partnerName: c.partnerId ? partnerById.get(c.partnerId)?.fullName : undefined,
    }));
  }

  async getDetail(id: string, actorUserId: string, actorRole: UserRole) {
    const found = await this.prisma.supportCase.findUnique({ where: { id }, include: { logs: { orderBy: { createdAt: 'asc' } } } });
    if (!found) throw new NotFoundException();
    const arrival = await this.prisma.order.findUnique({
      where: { id: found.orderId },
      select: { status: true, arrivedAt: true, arrivalVerification: true, arrivalDistanceM: true, arrivalAccuracyM: true, arrivalLatitude: true, arrivalLongitude: true, arrivalNote: true, snapshotLatitude: true, snapshotLongitude: true },
    });
    const kase: any = { ...found, order: arrival };
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    if (adminRoles.includes(actorRole)) {
      // Admin review: payment, penalty and refund status side by side (cancellation approval,
      // refund approval and refund completion are separate, visible states).
      if (SERVICE_REVIEW_ISSUES.includes(found.issueType)) {
        const order = await this.loadOrderForCase(found.orderId);
        if (order) {
          const ctx = await this.cancellationContext(order);
          kase.review = {
            startOtpVerified: !!order.startOtpVerified, orderStatus: order.status,
            paymentStatus: order.paymentStatus, bookingTotal: ctx.bookingTotal, paid: ctx.paid,
            alreadyRefunded: ctx.alreadyRefunded, inFlight: ctx.inFlight, refundable: ctx.refundable,
            penalty: { amount: ctx.penalty.penalty, rule: ctx.penalty.label, ...ctx.penalty.breakdown },
            suggestedRefund: money(Math.max(0, Number(found.refundedTotal || 0) + ctx.refundable - (order.arrivedAt && !serviceStarted(order) ? ctx.penalty.penalty : 0))),
            vendorPayout: Number(order.vendorPayout || 0), partnerPaidOut: !!order.completedAt || ['COMPLETED', 'INVOICED', 'CLOSED'].includes(order.status),
          };
        }
      }
      kase.refunds = await this.prisma.refundRequest.findMany({
        where: { OR: [{ supportCaseId: found.id }, ...(found.refundRequestId ? [{ id: found.refundRequestId }] : [])] },
        select: { id: true, status: true, decisionMode: true, approvedAmount: true, claimedAmount: true, walletCreditAmount: true, gatewayRefundAmount: true, gatewayRefundId: true, approvedAt: true, createdAt: true, providerRefund: { select: { status: true, providerRefundId: true, lastError: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return kase;
    }
    if (kase.customerId === actorUserId) return kase;
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
  constructor(private support: SupportCasesService, private warranty: WarrantyService) {}

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
  @Get('warranty-cases/mine') myWarrantyCases(@CurrentUser() u: JwtPayload) { return this.warranty.listForCustomer(u.sub); }

  @Get('cases/:id') detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.support.getDetail(id, u.sub, u.role);
  }

  // Partner, after arriving: customer refused the service (reason + remarks + fresh location).
  @Post('partner/orders/:orderId/customer-refused')
  partnerRefused(@CurrentUser() u: JwtPayload, @Param('orderId') orderId: string, @Body() b: PartnerRefusalDto) {
    return this.support.partnerReportRefusal(u.sub, orderId, b);
  }

  // Customer: cancel after the partner arrived/started — opens an admin review case.
  @Get('orders/:orderId/cancellation-preview')
  cancellationPreview(@CurrentUser() u: JwtPayload, @Param('orderId') orderId: string) {
    return this.support.cancellationPreview(u.sub, orderId);
  }

  @Post('orders/:orderId/cancellation-request')
  cancellationRequest(@CurrentUser() u: JwtPayload, @Param('orderId') orderId: string, @Body() b: CancellationRequestDto) {
    return this.support.requestCancellation(u.sub, orderId, b.reason);
  }

  // Customer: their side / dispute of a proposed charge, before the decision.
  @Post('cases/:id/customer-respond')
  customerRespond(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: CustomerStatementDto) {
    return this.support.customerRespond(u.sub, id, b.statement);
  }

  // Customer: one appeal of a decided cancellation case.
  @Post('cases/:id/appeal')
  appeal(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: CustomerStatementDto) {
    return this.support.customerAppeal(u.sub, id, b.statement);
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
    @Body() b: AdminDecideDto,
  ) {
    return this.support.adminDecide(u.sub, id, b.resolutionType, b.amount, b.reason, {
      newVendorId: b.newVendorId, partnerCompensation: b.partnerCompensation, cancelOrder: b.cancelOrder, partnerRecovery: b.partnerRecovery, penaltyAmount: b.penaltyAmount,
    });
  }

  // Admin: re-align a case's refund claim with the refunds actually processed (no money moves).
  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('cases/:id/reconcile-refund')
  reconcileRefund(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.support.reconcileRefundClaim(u.sub, id);
  }
}

@Module({
  imports: [RefundsModule, AdminModule, PartnerLedgerModule, PaymentNotificationsModule, NotificationsModule, ReturnsModule, WarrantyModule],
  controllers: [SupportCasesController],
  providers: [SupportPolicyEngine, SupportCasesService],
  exports: [SupportPolicyEngine, SupportCasesService],
})
export class SupportModule {}
