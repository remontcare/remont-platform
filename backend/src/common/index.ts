import {
  createParamDecorator, ExecutionContext, SetMetadata,
  Injectable, CanActivate, ForbiddenException, UnauthorizedException, BadRequestException,
  ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger,
  NestInterceptor, CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { UserRole, FulfillmentType, MemberStatus, DeliveryPartnerType } from '@prisma/client';
import * as crypto from 'crypto';

// ─── DECORATORS ─────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;
  phone: string;
  role: UserRole;
  name?: string;
  iat?: number;
  exp?: number;
}

export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata('isPublic', true);

// ─── GUARDS ─────────────────────────────────────────────────────────

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('User not authenticated');
    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) throw new ForbiddenException(`Requires role: ${requiredRoles.join(' or ')}`);
    return true;
  }
}

// ─── FILTERS & INTERCEPTORS ─────────────────────────────────────────

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | object = 'Internal server error';
    let errorCode = 'INTERNAL_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : (res as any).message || res;
      errorCode = (res as any).error || exception.name;
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.stack);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      errorCode,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const response = context.switchToHttp().getResponse();
    return next.handle().pipe(
      map((data) => ({
        success: true,
        statusCode: response.statusCode,
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}

// ─── UTILITIES ──────────────────────────────────────────────────────

export function generateOtp(length = 6): string {
  return Math.floor(Math.pow(10, length - 1) + Math.random() * 9 * Math.pow(10, length - 1)).toString();
}

// Scoped to RBAC-relevant admin actions (role grants, blocks, delete-request
// decisions) — not a general-purpose activity log for the whole platform.
// Plain append-only status-change log per Order — not the general event-driven
// architecture (explicitly deferred); a direct insert called from order-lifecycle code.
export async function writeOrderTimeline(prisma: any, entry: {
  orderId: string;
  status: string;
  note?: string;
  actorId?: string;
  actorRole?: UserRole;
}): Promise<void> {
  await prisma.orderTimeline.create({
    data: {
      orderId: entry.orderId,
      status: entry.status,
      note: entry.note,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
    },
  });
}

// Append-only audit trail for job start/completion OTPs — same direct-insert pattern
// as writeOrderTimeline above, no event bus. Called at initial generation (booking
// time), on regeneration ("Request OTP Again"), and on successful verification.
export async function writeOtpLog(prisma: any, entry: {
  orderId: string;
  otpType: 'START' | 'END';
  otp: string;
  action: 'GENERATED' | 'REGENERATED' | 'VERIFIED';
  requestedByRole?: 'VENDOR' | 'SYSTEM' | 'ADMIN';
  requestedById?: string;
}): Promise<void> {
  await prisma.orderOtpLog.create({
    data: {
      orderId: entry.orderId,
      otpType: entry.otpType,
      otp: entry.otp,
      action: entry.action,
      requestedByRole: entry.requestedByRole,
      requestedById: entry.requestedById,
    },
  });
}

// 30-60s cooldown window the requirement asks for, between "Request OTP Again" taps
// for the same (order, otpType) — picked the middle of that range.
export const OTP_REGEN_COOLDOWN_SECONDS = 45;

// ─── Vendor dispatch eligibility (single source of truth) ────────────────────
// Allowlist, deliberately not a blocklist of PROJECT/ADMIN_TEAM: a FulfillmentType this
// list doesn't name is hidden from vendors by default. If a new in-house-only type gets
// added to the FulfillmentType enum later, vendor visibility stays safe automatically —
// nobody has to remember to also blocklist it here. RoutingService (which decides admin
// queue vs. auto-dispatch) and VendorsService (availableJobs()/acceptJob(), the vendor
// pull-list + accept path) both key off this same constant so there is exactly one place
// to change the vendor-dispatchable set.
export const VENDOR_DISPATCHABLE_FULFILLMENT_TYPES: FulfillmentType[] = [FulfillmentType.DIRECT_PARTNER];

// ServiceVendor.memberStatus is nullable — null means "not an agency team member at all"
// (an independent partner vendor), NOT "not frozen". A bare `memberStatus: { not: 'FROZEN' }`
// compiles to SQL `<> 'FROZEN'`, and NULL <> 'FROZEN' evaluates to UNKNOWN (not TRUE) under
// three-valued SQL logic — so that filter silently excludes every independent vendor, not
// just frozen agency members. This was live in DispatchService.dispatch() and
// RoutingService.route() (Phase 2 agency-management code), meaning automatic dispatch has
// been skipping every non-agency vendor. Spread this into a Prisma `where` (as the `OR` key)
// everywhere a "not a frozen agency member" filter is needed, instead of re-writing the
// null-unsafe version.
export const NOT_FROZEN_MEMBER_FILTER = { OR: [{ memberStatus: null }, { memberStatus: { not: MemberStatus.FROZEN } }] };

// ─── Commission resolution (Task 9) ──────────────────────────────────────────
// Category-level, service-level, and city-wise platform commission, with an
// explicit priority + fallback order:
//   (a) a CATEGORY-level rule (matching this city, or "all cities") applies to
//       every service in that category by default;
//   (b) a SERVICE-level rule OVERRIDES the category rule for that one service
//       when both exist;
//   (c) if no category rule exists at all, a SERVICE-level rule still applies
//       directly;
//   (d) if nothing matches, commission is a SiteSetting default (or 0).
// A rule marked `stackable` adds its own amount on top of whichever single rule
// won above — opt-in per rule, so two rules never silently combine by accident.
type CommissionRuleRow = {
  id: string;
  scope: 'CATEGORY' | 'SERVICE';
  categoryId: string | null;
  serviceId: string | null;
  cityId: string | null;
  commissionType: 'PERCENTAGE' | 'FLAT' | 'SLAB';
  value: unknown; // Prisma Decimal
  slabJson: unknown;
  priority: number;
  stackable: boolean;
};

function computeRuleAmount(rule: CommissionRuleRow, amount: number): number {
  if (rule.commissionType === 'FLAT') return Number(rule.value);
  if (rule.commissionType === 'PERCENTAGE') return (amount * Number(rule.value)) / 100;
  if (rule.commissionType === 'SLAB') {
    const slabs = Array.isArray(rule.slabJson) ? (rule.slabJson as any[]) : [];
    const match = slabs.find((s) => amount >= (s.min ?? 0) && (s.max == null || amount <= s.max));
    if (!match) return 0;
    return match.type === 'FLAT' ? Number(match.value) : (amount * Number(match.value)) / 100;
  }
  return 0;
}

function describeRule(rule: CommissionRuleRow): string {
  const kind = rule.scope === 'SERVICE' ? 'Service' : 'Category';
  const scopeLabel = rule.cityId ? '' : ' (all cities)';
  if (rule.commissionType === 'PERCENTAGE') return `${kind} rule: ${rule.value}%${scopeLabel}`;
  if (rule.commissionType === 'FLAT') return `${kind} rule: ₹${rule.value} flat${scopeLabel}`;
  return `${kind} rule: slab-based${scopeLabel}`;
}

export async function resolveCommission(
  prisma: any,
  params: { serviceId: string; categoryId: string; cityId?: string | null; amount: number },
): Promise<{ commissionAmount: number; ruleId: string | null; ruleLabel: string }> {
  const { serviceId, categoryId, cityId, amount } = params;
  const now = new Date();

  const rules: CommissionRuleRow[] = await prisma.commissionRule.findMany({
    where: {
      isActive: true,
      OR: [{ serviceId }, { categoryId, serviceId: null }],
      AND: [
        { OR: [{ cityId: null }, { cityId: cityId || undefined }] },
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validTo: null }, { validTo: { gte: now } }] },
      ],
    },
    orderBy: { priority: 'desc' },
  });

  // City-specific beats "all cities" at the same scope level.
  const bySpecificity = (a: CommissionRuleRow, b: CommissionRuleRow) => {
    const score = (r: CommissionRuleRow) => (r.cityId ? 1 : 0) * 10 + r.priority;
    return score(b) - score(a);
  };

  const serviceRules = rules.filter((r) => r.serviceId === serviceId).sort(bySpecificity);
  const categoryRules = rules.filter((r) => r.categoryId === categoryId && !r.serviceId).sort(bySpecificity);

  // (b) service-level overrides category-level when both exist; (c) service-level
  // alone still applies when no category rule exists.
  const primary = serviceRules[0] || categoryRules[0] || null;

  if (!primary) {
    const setting = await prisma.siteSetting.findUnique({ where: { key: 'default_commission_pct' } });
    const pct = setting ? parseFloat(setting.value) || 0 : 0;
    const commissionAmount = Math.round(((amount * pct) / 100) * 100) / 100;
    return { commissionAmount, ruleId: null, ruleLabel: pct > 0 ? `Default (${pct}%)` : 'No rule — ₹0' };
  }

  let commissionAmount = computeRuleAmount(primary, amount);
  const stacked = rules.filter((r) => r.id !== primary.id && r.stackable);
  for (const r of stacked) commissionAmount += computeRuleAmount(r, amount);

  const label = describeRule(primary) + (stacked.length ? ` + ${stacked.length} stacked rule(s)` : '');
  return { commissionAmount: Math.round(commissionAmount * 100) / 100, ruleId: primary.id, ruleLabel: label };
}

// ─── Bundle offer (product + service checked out together) ──────────────────
// Admin-configurable via SiteSetting key 'bundle_discount_percent' (seeded to '10' by the
// migration that introduced this feature; also editable from Admin > Settings >
// Operations, same generic key/value UI every other percent-style setting already uses —
// see resolveCommission()'s 'default_commission_pct' above for the identical read pattern).
// Clamped to [0, 100] so an admin fat-finger (e.g. "1000") can never zero out or invert a
// service's price; missing/unparsable falls back to 10, matching the seeded default.
export async function getBundleDiscountPercent(prisma: any): Promise<number> {
  const setting = await prisma.siteSetting.findUnique({ where: { key: 'bundle_discount_percent' } });
  const pct = setting ? parseFloat(setting.value) : NaN;
  if (!Number.isFinite(pct) || pct < 0) return 10;
  return Math.min(pct, 100);
}

// ─── Product marketplace fee resolution (Phase 7) ────────────────────────────
// Same algorithm/idiom as resolveCommission() above, generalized across `feeType`
// (COMMISSION/MARKETING/GATEWAY/OTHER) so every current and future non-delivery
// marketplace fee for PRODUCT sellers shares one resolver — see ProductFeeRule in
// schema.prisma and the plan doc "Phase 7" for why this is a new sibling model rather
// than an extension of CommissionRule (that one's categoryId/serviceId are typed FKs to
// ServiceCategory/Service specifically). No city dimension here (product pricing/fees
// don't vary by city today, unlike services).
//   (a) a PRODUCT_CATEGORY-level rule applies to every product in that category;
//   (b) a PRODUCT-level rule OVERRIDES the category rule for that one product;
//   (c) if nothing matches, resolves to 0 — a SiteSetting default is consulted ONLY for
//       feeType=COMMISSION (`default_commission_pct`, the exact same key/convention
//       resolveCommission() already uses for services — deliberately not a new hardcoded
//       number); MARKETING/GATEWAY/OTHER have no site-wide fallback and simply resolve to
//       0 with ruleLabel 'No rule — ₹0' when unconfigured, since inventing a default for
//       those would violate the explicit "never hardcode a fee percentage" requirement.
type ProductFeeRuleRow = {
  id: string;
  scope: 'PRODUCT_CATEGORY' | 'PRODUCT';
  productCategoryId: string | null;
  productId: string | null;
  commissionType: 'PERCENTAGE' | 'FLAT' | 'SLAB';
  value: unknown;
  slabJson: unknown;
  priority: number;
  stackable: boolean;
};

function describeProductFeeRule(rule: ProductFeeRuleRow): string {
  const kind = rule.scope === 'PRODUCT' ? 'Product' : 'Category';
  if (rule.commissionType === 'PERCENTAGE') return `${kind} rule: ${rule.value}%`;
  if (rule.commissionType === 'FLAT') return `${kind} rule: ₹${rule.value} flat`;
  return `${kind} rule: slab-based`;
}

export async function resolveProductFee(
  prisma: any,
  params: { feeType: 'COMMISSION' | 'MARKETING' | 'GATEWAY' | 'OTHER'; productId: string; productCategoryId: string; amount: number },
): Promise<{ feeAmount: number; ruleId: string | null; ruleLabel: string }> {
  const { feeType, productId, productCategoryId, amount } = params;
  const now = new Date();

  const rules: ProductFeeRuleRow[] = await prisma.productFeeRule.findMany({
    where: {
      feeType,
      isActive: true,
      OR: [{ productId }, { productCategoryId, productId: null }],
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validTo: null }, { validTo: { gte: now } }] },
      ],
    },
    orderBy: { priority: 'desc' },
  });

  const productRules = rules.filter((r) => r.productId === productId);
  const categoryRules = rules.filter((r) => r.productCategoryId === productCategoryId && !r.productId);
  const primary = productRules[0] || categoryRules[0] || null;

  if (!primary) {
    if (feeType !== 'COMMISSION') {
      return { feeAmount: 0, ruleId: null, ruleLabel: 'No rule — ₹0' };
    }
    const setting = await prisma.siteSetting.findUnique({ where: { key: 'default_commission_pct' } });
    const pct = setting ? parseFloat(setting.value) || 0 : 0;
    const feeAmount = Math.round(((amount * pct) / 100) * 100) / 100;
    return { feeAmount, ruleId: null, ruleLabel: pct > 0 ? `Default (${pct}%)` : 'No rule — ₹0' };
  }

  let feeAmount = computeRuleAmount(primary as any, amount);
  const stacked = rules.filter((r) => r.id !== primary.id && r.stackable);
  for (const r of stacked) feeAmount += computeRuleAmount(r as any, amount);

  const label = describeProductFeeRule(primary) + (stacked.length ? ` + ${stacked.length} stacked rule(s)` : '');
  return { feeAmount: Math.round(feeAmount * 100) / 100, ruleId: primary.id, ruleLabel: label };
}

// Phase 8 (H-07) — Product.stock previously existed but was never read or decremented
// anywhere in checkout (MasterOrdersService.checkout(), OrdersService.create(),
// GuestBookingService.publicProductCheckout()) — every product order could oversell
// indefinitely. This is the one shared, minimal fix: an atomic conditional decrement (the
// same "updateMany guarded on a WHERE condition, check count===1" idiom already used
// throughout this codebase — e.g. ReturnsService.finalize()'s claim-before-side-effect
// pattern) so two concurrent checkouts racing on the same product's last unit can never
// both succeed. A plain read-then-write here would not be safe under concurrency; this is.
// Deliberately targets only Product.stock (not the separate PickupLocation/CityProduct
// per-location stock breakdowns) — the minimum extent the current checkout model needs,
// not a warehouse management system. Must be called with a transaction client so a stock
// failure rolls back the whole checkout instead of leaving a decremented-but-orderless gap.
export async function reserveProductStock(tx: any, items: { productId: string; quantity: number }[]): Promise<void> {
  const qtyByProduct = new Map<string, number>();
  for (const it of items) qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) || 0) + it.quantity);
  for (const [productId, quantity] of qtyByProduct) {
    if (quantity <= 0) continue;
    const result = await tx.product.updateMany({
      where: { id: productId, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    });
    if (result.count !== 1) {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true, stock: true } });
      throw new BadRequestException(`Insufficient stock for ${product?.name || 'this product'} (available: ${product?.stock ?? 0}, requested: ${quantity})`);
    }
  }
}

export async function logAudit(prisma: any, entry: {
  actorId: string;
  actorRole: UserRole;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata,
      ip: entry.ip,
    },
  });
}

export function generateOrderNumber(prefix: string, count: number): string {
  return `${prefix}-${(count + 10000).toString().padStart(5, '0')}`;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Phase 5 — shared nearest-available-rider matcher, extracted out of the pre-existing (but
// previously dead-code) DeliveryService.nearest() so it can be reused by MockDeliveryProvider
// (backend/src/modules/logistics/providers/mock-provider.ts) without a module import cycle
// between DeliveryModule and LogisticsModule. Best-effort by design: returns null if nobody
// is within range, matching the caller's existing "shipment can still be created with no
// rider available yet" behaviour.
export async function findNearestDeliveryPartner(
  prisma: any, type: DeliveryPartnerType, lat: number, lng: number, maxKm: number,
): Promise<any | null> {
  const partners = await prisma.deliveryPartner.findMany({
    where: {
      type, isAvailable: true, status: 'ACTIVE',
      currentLatitude: { not: null }, currentLongitude: { not: null },
    },
    take: 20,
  });
  let best: { partner: any; d: number } | null = null;
  for (const p of partners) {
    const d = haversineKm(lat, lng, p.currentLatitude, p.currentLongitude);
    if (d <= maxKm && (!best || d < best.d)) best = { partner: p, d };
  }
  return best?.partner || null;
}

// No vendor can configure a serviceRadius above this (ServiceVendorRegistrationDto's
// @Max(100) in vendors.module.ts) — the true upper bound on "could this vendor possibly be
// eligible", used only to size the DB-level geographic prefilter below. Raising the per-
// vendor max later must raise this too, or the prefilter could start excluding a real
// long-radius vendor before the exact haversineKm+serviceRadius check ever sees them.
export const MAX_DISPATCH_RADIUS_KM = 100;

// Scale fix: DispatchService.dispatch()'s GPS candidate query previously pulled the first
// N online+matching-skill vendors NATIONWIDE with no geographic filter at all, then computed
// exact distance in-app — once the online vendor count nationwide exceeds N, the real
// nearest vendor for a given order might simply never be among the rows fetched. This
// computes a generous (never-too-small) lat/lng bounding box around a point so the DB query
// itself can use the new ServiceVendor(currentLatitude, currentLongitude) index to narrow to
// a geographically plausible candidate set before the exact-distance check runs in-app —
// same "cheap bounding box, then exact math" pattern spatial queries always use when a
// database has no native geo index type available (this one doesn't use PostGIS).
export function boundingBoxForRadius(lat: number, lng: number, radiusKm: number) {
  const latDeltaDeg = radiusKm / 111.32; // ~km per degree of latitude, everywhere
  // km per degree of longitude shrinks toward the poles by cos(latitude); India's latitude
  // range (isValidIndiaCoords: 6.5°-37.6°) never gets close enough to 90° for this to blow up.
  const lngDeltaDeg = radiusKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    minLat: lat - latDeltaDeg, maxLat: lat + latDeltaDeg,
    minLng: lng - lngDeltaDeg, maxLng: lng + lngDeltaDeg,
  };
}

// A missing/never-captured GPS fix is stored as (0,0) throughout this codebase (Prisma's
// Address/ServiceVendor location columns default to 0, not null) — so "(0,0)" is this
// codebase's actual null-island sentinel, not a real location anyone is ever standing at.
// Treating it as real data breaks distance math (haversineKm(0,0, realLat, realLng) computes
// thousands of km, silently excluding every vendor from dispatch/eligibility). Centralized
// here so every write path (order creation) and every read path (dispatch matching) agrees
// on the exact same bounding box, instead of re-deriving/duplicating these bounds per call site.
export function isValidIndiaCoords(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return lat != null && lng != null && lat !== 0 && lng !== 0 &&
    lat >= 6.5 && lat <= 37.6 && lng >= 68.1 && lng <= 97.4;
}

// A vendor's currentLatitude/Longitude come from their last location ping — without a
// staleness cutoff, a vendor who went offline hours/days ago but never got flipped
// isOnline:false would still count as "at" their last-known GPS fix. Shared so every GPS-
// distance eligibility check (DispatchService.dispatch's automatic offer wave,
// ServiceVendorsService.isEligibleForOrder's manual accept/available-jobs re-validation)
// agrees on the same cutoff instead of one enforcing it and the other silently not.
export const LOCATION_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

// The ONE authoritative location-eligibility rule, shared by every path that decides whether
// a given vendor may be matched to a given order: DispatchService.dispatch's no-GPS fallback,
// ServiceVendorsService.isEligibleForOrder (partner's own available-jobs/accept re-check), and
// AdminService.listActiveVendors (manual assignment candidate list). Before this was shared,
// isEligibleForOrder and listActiveVendors had genuinely different rules — manual assignment
// had no city/GPS filter at all, only a display-only distance sort — so an admin manually
// assigning a job could see (and pick) a vendor from an entirely different city.
// Prefers GPS-radius matching when the vendor has a fresh (not stale) location fix AND the
// order has a real captured GPS fix; otherwise falls back to exact (case-insensitive)
// city-text matching, which is also what happens when neither side has usable coordinates.
export function isVendorLocationEligible(
  vendor: { currentLatitude: number | null; currentLongitude: number | null; lastLocationUpdate: Date | string | null; serviceRadius: number; baseCity: string },
  order: { address?: { latitude?: number | null; longitude?: number | null; city?: string | null } | null },
): boolean {
  const address = order.address;
  const vendorHasFreshLocation = vendor.currentLatitude != null && vendor.currentLongitude != null &&
    vendor.lastLocationUpdate != null && (Date.now() - new Date(vendor.lastLocationUpdate).getTime()) < LOCATION_STALE_AFTER_MS;
  if (vendorHasFreshLocation && isValidIndiaCoords(address?.latitude, address?.longitude)) {
    return haversineKm(vendor.currentLatitude!, vendor.currentLongitude!, address!.latitude!, address!.longitude!) <= vendor.serviceRadius;
  }
  return !address?.city || address.city.toLowerCase() === vendor.baseCity.toLowerCase();
}

// PaymentTransaction.orderId marker for a vendor wallet top-up (WithdrawalService.
// initiateTopup/confirmTopup in partner-ledger.module.ts) — mirrors the customer wallet's
// own historical 'WALLET_TOPUP' marker (now superseded there by the real isWalletTopup
// boolean; kept as a marker here since a vendor topup has no equivalent boolean column).
// Exported so PaymentsService.handleWebhook can recognize it without importing
// PartnerLedgerModule (which already imports PaymentsModule — importing back would cycle).
export const VENDOR_WALLET_TOPUP_MARKER = 'VENDOR_WALLET_TOPUP';

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ─── Address validation (Address Management) ─────────────────────────────────
// Server-side mirror of the frontend's AddressValidation (index.html) — the
// client already blocks these, but the API must reject them too since it can be
// called directly. Shared by UsersService.addAddress/updateAddress.
const PINCODE_BLACKLIST = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '121212', '101010', '100000', '010101']);

export function validatePincode(pincode: string): string | null {
  if (!pincode) return 'PIN code is required';
  if (!/^\d{6}$/.test(pincode)) return 'PIN code must be exactly 6 digits';
  if (PINCODE_BLACKLIST.has(pincode)) return 'Enter a valid PIN code';
  return null;
}

// A run of 5+ consonants inside one alphabetic word almost never occurs in a real
// place name/address ("hshsvx", "lxskjius") — catches keyboard-mash gibberish
// without flagging real (if unusual) addresses.
function hasLongConsonantRun(word: string, minRun = 5): boolean {
  let run = 0;
  for (const ch of word.toLowerCase()) {
    if ('aeiou'.includes(ch)) run = 0;
    else if (/[a-z]/.test(ch)) { run++; if (run >= minRun) return true; }
    else run = 0;
  }
  return false;
}

export function validateAddressLine(text: string): string | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'Address is required';
  if (trimmed.length < 10) return 'Address must be at least 10 characters';
  if (/^(.)\1+$/.test(trimmed.replace(/\s+/g, ''))) return 'Enter a valid address';
  const words = trimmed.match(/[a-zA-Z]+/g) || [];
  if (words.some((w) => w.length >= 6 && hasLongConsonantRun(w))) return "This doesn't look like a valid address";
  return null;
}

// `partial: true` (PATCH semantics) only validates fields actually present in `data` —
// a PATCH that isn't touching pincode shouldn't fail because city is missing.
export function validateAddressInput(
  data: { fullAddress?: string; pincode?: string; city?: string; state?: string },
  opts: { partial?: boolean } = {},
): void {
  const errors: string[] = [];
  const shouldCheck = (v: unknown) => !opts.partial || v !== undefined;

  if (shouldCheck(data.fullAddress)) {
    const err = validateAddressLine(data.fullAddress || '');
    if (err) errors.push(err);
  }
  if (shouldCheck(data.pincode)) {
    const err = validatePincode(data.pincode || '');
    if (err) errors.push(err);
  }
  if (shouldCheck(data.city) && !(data.city || '').trim()) errors.push('City is required');
  if (shouldCheck(data.state) && !(data.state || '').trim()) errors.push('State is required');

  if (errors.length) throw new BadRequestException(errors.join('; '));
}

// Address snapshot copied onto Order/MasterOrder at booking time — see the schema
// comment on Order.snapshotAddressLine. Takes whatever Address row was just
// resolved (freshly created inline, or an existing saved one looked up by id) and
// returns the flat fields to spread into the order.create()/masterOrder.create() data.
export function addressSnapshotFields(addr?: {
  fullAddress: string;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
  latitude?: unknown;
  longitude?: unknown;
  capturedAt?: Date | null;
} | null) {
  if (!addr) return {};
  const lat = addr.latitude != null ? Number(addr.latitude) : null;
  const lng = addr.longitude != null ? Number(addr.longitude) : null;
  return {
    snapshotAddressLine: addr.fullAddress,
    snapshotLandmark: addr.landmark || null,
    snapshotCity: addr.city,
    snapshotState: addr.state,
    snapshotPincode: addr.pincode,
    snapshotLatitude: lat,
    snapshotLongitude: lng,
    snapshotGpsAt: addr.capturedAt || null,
  };
}

// Shared GST invoice math — see backend/src/common/billing-engine.ts for the actual
// calculation engine (calculateInvoice, resolveBillingTransactionType, GSTIN helpers).
// This helper builds the Invoice-row shape (page 1/2/3 fields) that InvoicesService,
// OrdersService.autoGenerateInvoice(), and AdminService both persist, so the engine call
// + field mapping stays in one place rather than copy-pasted at each call site (the bug
// this replaces: three drifting hardcoded-9%+9% copies, one of which — the admin
// "Generate Invoice" button — didn't even share code with the other two).
export * from './billing-engine';
import {
  calculateInvoice, stateFromGstin, normalizeState,
  type BillingTransactionTypeValue, type BillingLineInput,
} from './billing-engine';

export interface InvoiceBuildInput {
  orderNumber: string;
  transactionType: BillingTransactionTypeValue;
  placeOfSupply: string;
  /** Remont's own registered state — from the `company_state` SiteSetting. */
  remontState: string;
  remontGstin: string;
  bookingFee?: number;

  // Customer-facing line items (Type 2: full project lines; Type 1: informational
  // partner-amount + fee summary; Type 3: the seller's product lines).
  customerLines: BillingLineInput[];
  customerSupplierState?: string | null; // Remont for Type 1/2, seller's state for Type 3
  customerSupplierGstin?: string | null;

  // Partner/vendor settlement side (Type 1 only) — never a Remont tax invoice.
  vendorLines?: BillingLineInput[];
  vendorGstin?: string | null;

  // Remont's own platform-fee / commission invoice (Type 1: fee to customer; Type 3:
  // commission to seller — different recipient, so a distinct placeOfSupply).
  remontLines?: BillingLineInput[];
  remontPlaceOfSupply?: string;

  // Phase 3 (M-04) — the order's real customer-facing discount, always shown on the
  // invoice (never hardcoded to 0 — see the Phase 3 report). Callers are responsible for
  // deciding whether it has already been baked into customerLines[].discount (reducing
  // taxable value — done upstream only when the discount is SELLER-funded or a SERVICE/
  // DIRECT_PROJECT line, mirroring what checkout already computed GST on) via
  // discountReducesTaxableValue=true, in which case `discount` here is purely for display
  // and customerTotal is customer.total unchanged; or left out of every line entirely
  // (PLATFORM-funded PRODUCT discounts, where GST-law treatment is an open CA decision —
  // see OrderDiscountAllocation.gstTreatment) via discountReducesTaxableValue=false, in
  // which case `discount` is subtracted from customer.total post-tax so the invoice total
  // still reconciles to what the customer actually paid.
  discount?: number;
  discountReducesTaxableValue?: boolean;
}

export function buildInvoiceBreakdown(input: InvoiceBuildInput) {
  const customer = calculateInvoice({
    lines: input.customerLines,
    supplierState: input.customerSupplierState ?? input.remontState,
    placeOfSupply: input.placeOfSupply,
  });

  const vendor = input.vendorLines?.length
    ? calculateInvoice({
        lines: input.vendorLines,
        supplierState: stateFromGstin(input.vendorGstin), // null (unregistered) => no GST fabricated
        placeOfSupply: input.placeOfSupply,
      })
    : null;

  const remontLines = input.remontLines || [];
  const remont = calculateInvoice({
    lines: input.bookingFee
      ? [...remontLines, { description: 'Booking Fee', qty: 1, rate: input.bookingFee, taxRatePercent: remontLines[0]?.taxRatePercent ?? 18 }]
      : remontLines,
    supplierState: input.remontState,
    placeOfSupply: input.remontPlaceOfSupply || input.placeOfSupply,
  });

  const discount = Math.round(((input.discount || 0) + Number.EPSILON) * 100) / 100;
  // discountReducesTaxableValue=true means the caller already folded `discount` into the
  // relevant customerLines[].discount entries, so customer.total already reflects it —
  // subtracting it again here would double-count. false (or omitted, e.g. every pre-Phase-3
  // call site that never sets this and never had a discount concept) means it hasn't been
  // applied to any line yet, so it comes off the total here, post-tax.
  const customerTotal = input.discountReducesTaxableValue ? customer.total : Math.round((customer.total - discount) * 100) / 100;

  return {
    // Phase 5 (C-07/C-08/L-01) — invoiceNumber/vendorDocumentNumber/remontDocumentNumber
    // are no longer computed here: each is its own legal document's number, generated
    // atomically per-series by nextInvoiceDocumentNumber() and attached by the caller
    // (InvoicesService.generateForOrder()) right before the Invoice row is created.
    transactionType: input.transactionType,
    placeOfSupply: input.placeOfSupply,
    supplierState: input.customerSupplierState ?? input.remontState,
    supplierGstin: input.customerSupplierGstin ?? input.remontGstin,

    customerSubtotal: customer.taxableValue,
    customerCgst: customer.cgst,
    customerSgst: customer.sgst,
    customerIgst: customer.igst,
    customerTotal,

    vendorLabor: vendor?.taxableValue ?? 0,
    vendorMaterial: 0,
    vendorCgst: vendor?.cgst ?? 0,
    vendorSgst: vendor?.sgst ?? 0,
    vendorTotal: vendor?.total ?? 0,

    platformCommission: remont.taxableValue,
    bookingFee: input.bookingFee ?? 0,
    remontCgst: remont.cgst,
    remontSgst: remont.sgst,
    remontIgst: remont.igst,
    remontTotal: remont.total,

    discount,
    roundOff: customer.roundOff,
    // Cast to `any` — Prisma's generated JsonValue input type can't structurally match a
    // typed interface array even though this is plain, JSON-serializable data.
    lineItemsSnapshot: { customer: customer.lines, vendor: vendor?.lines ?? [], remont: remont.lines } as any,
  };
}

// ─── Phase 5 — invoice document numbering (C-07 concurrency, C-08 document separation,
// L-01 financial year) ───────────────────────────────────────────────────────────────────
// Before this, InvoicesService.generateForOrder() derived its one invoiceNumber from
// `await prisma.invoice.count()` — read-then-compute-then-insert, no locking, no FY
// component — and reused that SAME number on all 3 PDF pages (invoice-pdf.ts), even
// though the VENDOR (partner→customer) and REMONT (Remont→seller commission) pages are
// legally distinct documents from the CUSTOMER page. The database is now the sole
// authority for uniqueness: nextInvoiceDocumentNumber() below is a single atomic
// `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per (series, financial year) — never a
// separate read followed by a write — so two concurrent invoice generations, even for the
// same series in the same FY, can never receive the same sequence number.

/** One independent numbering series per legally-distinct document this app can issue.
 * CUSTOMER_TAX_INVOICE also covers the Type-1 "booking summary" page (never itself a GST
 * document, but still needs a stable reference number) — see generateForOrder(). */
export type InvoiceSeries = 'CUSTOMER_TAX_INVOICE' | 'PARTNER_SETTLEMENT_INVOICE' | 'PLATFORM_FEE_INVOICE' | 'CREDIT_NOTE';

const INVOICE_SERIES_TOKEN: Record<InvoiceSeries, string> = {
  CUSTOMER_TAX_INVOICE: 'CTI',
  PARTNER_SETTLEMENT_INVOICE: 'PSI',
  PLATFORM_FEE_INVOICE: 'PFI',
  // Phase 6 (C-06) — its own series, distinct from every invoice series above: a credit
  // note is a different legal document type, not a renumbered/replacement invoice.
  CREDIT_NOTE: 'CN',
};

/** Indian financial year (Apr 1 – Mar 31), e.g. 2026-08-30 -> '2026-27', 2027-02-01 ->
 * '2026-27', 2027-04-01 -> '2027-28'. Pure — no DB, trivially unit-testable. */
export function financialYearLabel(date: Date): string {
  const isAprOnward = date.getMonth() >= 3; // Date.getMonth() is 0-indexed; 3 = April
  const startYear = isAprOnward ? date.getFullYear() : date.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Preserves the existing "INV-" prefix style (was `INV-${orderNumber}-${seq}`) while
 * adding the two properties that were missing: a series token so different legal
 * documents can never collide on the same number, and the financial year. */
function formatInvoiceDocumentNumber(series: InvoiceSeries, financialYear: string, seq: number): string {
  return `INV-${INVOICE_SERIES_TOKEN[series]}-${financialYear}-${String(seq).padStart(6, '0')}`;
}

/**
 * Atomically allocates the next sequence number for one (series, financial year) and
 * returns the fully formatted document number. Must be called with a Prisma transaction
 * client (`tx`) that also creates the Invoice row in the SAME transaction (see
 * InvoicesService.generateForOrder()) — if the invoice insert fails afterward, the whole
 * transaction rolls back and this number is never actually issued (a gap, not a reuse).
 * The single INSERT..ON CONFLICT..RETURNING statement is atomic under Postgres row-level
 * locking on its own — never a separate SELECT followed by an UPDATE — so this is safe
 * under arbitrary concurrency without any extra application-level locking.
 */
export async function nextInvoiceDocumentNumber(tx: any, series: InvoiceSeries, atDate: Date = new Date()): Promise<string> {
  const financialYear = financialYearLabel(atDate);
  const id = crypto.randomUUID();
  const rows: { lastNumber: number | bigint }[] = await tx.$queryRaw`
    INSERT INTO "InvoiceNumberSequence" ("id", "series", "financialYear", "lastNumber", "updatedAt")
    VALUES (${id}, ${series}, ${financialYear}, 1, NOW())
    ON CONFLICT ("series", "financialYear")
    DO UPDATE SET "lastNumber" = "InvoiceNumberSequence"."lastNumber" + 1, "updatedAt" = NOW()
    RETURNING "lastNumber"
  `;
  return formatInvoiceDocumentNumber(series, financialYear, Number(rows[0].lastNumber));
}

// ─── Phase 7 — GST TCS (Section 52) ─────────────────────────────────────────────────────
// Remont acts as an Electronic Commerce Operator for MARKETPLACE_PRODUCT orders — it
// collects customer consideration on behalf of the ProductVendor and settles them net of
// its own fees. TCS is withheld from that settlement, not added to the customer invoice —
// see ProductLedgerService.settleProductOrder() for where this is actually posted.

/** Reads the current TCS rate from the EXISTING TaxConfig table (type: 'TCS',
 * appliesTo: ['MARKETPLACE_PRODUCT_TCS']) — reused rather than a new rate-config model, so
 * the admin's existing Taxes screen / effective-dating (validFrom/validTo) idiom covers TCS
 * too. Returns 0 (nothing withheld) when no active TCS row is configured — this phase never
 * assumes a rate; an admin/CA must configure one before any TCS is actually collected. */
export async function resolveTcsRatePercent(prisma: any, atDate: Date = new Date()): Promise<number> {
  const row = await prisma.taxConfig.findFirst({
    where: {
      type: 'TCS', appliesTo: { has: 'MARKETPLACE_PRODUCT_TCS' }, isActive: true,
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: atDate } }] },
        { OR: [{ validTo: null }, { validTo: { gte: atDate } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  return row ? Number(row.rate) : 0;
}

/** Splits a TCS amount into CGST/SGST vs IGST components exactly like calculateInvoice()
 * (billing-engine.ts) splits ordinary GST — same intra/inter-state rule, applied here to
 * Remont's OWN registered state vs the SELLER's state (TCS is collected against the
 * supplier's location relative to the ECO's registration, not the customer's). Assumes
 * Remont holds a single GST registration (this codebase's existing single-state
 * BillingCompanyConfig model) — a multi-state ECO would need per-state TCS registration,
 * which is a real compliance requirement this phase does not model (see the Phase 7
 * report's CA_REVIEW_REQUIRED list). */
export function computeTcsSplit(taxableBase: number, ratePercent: number, remontState: string, sellerState: string | null): { cgst: number; sgst: number; igst: number; total: number } {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const total = round2((taxableBase * ratePercent) / 100);
  if (total <= 0) return { cgst: 0, sgst: 0, igst: 0, total: 0 };
  const intraState = !!sellerState && normalizeState(remontState) === normalizeState(sellerState);
  if (intraState) {
    const cgst = round2(total / 2);
    return { cgst, sgst: round2(total - cgst), igst: 0, total };
  }
  return { cgst: 0, sgst: 0, igst: total, total };
}

// ─── Phase 7 — e-Invoice (IRP) applicability ────────────────────────────────────────────
// e-Invoicing is mandatory only for a GST-registered issuer whose OWN turnover has crossed
// the notified threshold (a real-world fact no code can determine) AND only for a B2B
// supply (an unregistered/no-GSTIN customer is B2C, exempt regardless of turnover). Never
// assumed true — gated on an explicit per-entity opt-in flag an admin sets only once that
// entity's own CA has confirmed applicability (Invoice/ProductVendor.eInvoiceEnabled-style
// flag; Remont's own flag lives in SiteSetting — see EInvoiceService, compliance.module.ts).

export interface EInvoiceApplicabilityInput {
  issuerGstin?: string | null;
  issuerEInvoicingEnabled: boolean; // admin-confirmed: this issuing entity's turnover has crossed the threshold
  recipientGstin?: string | null; // presence = B2B; absence = B2C
}

export function checkEInvoiceApplicability(input: EInvoiceApplicabilityInput): { required: boolean; reason: string } {
  if (!input.issuerGstin) return { required: false, reason: 'Issuing entity has no GSTIN — not a registered supply' };
  if (!input.issuerEInvoicingEnabled) return { required: false, reason: 'e-Invoicing not yet enabled for this issuer (turnover threshold not confirmed)' };
  if (!input.recipientGstin) return { required: false, reason: 'B2C supply (recipient has no GSTIN) — e-Invoice mandate is B2B only' };
  return { required: true, reason: 'B2B supply by an e-Invoice-enabled registered issuer' };
}

// ─── Phase 7 — e-Way Bill applicability ─────────────────────────────────────────────────
// Only PRODUCT orders move goods; only a consignment value above the notified threshold
// (configurable — the CGST base threshold has historically been ₹50,000 but is a statutory
// figure this phase never hardcodes as a fallback rate, only as a fallback UI default) needs
// one. Intra vs inter-state is recorded for the EWB payload but does not itself gate
// applicability here — some states additionally exempt certain intra-state movement below
// higher state-specific thresholds, which is not modeled (see the Phase 7 report).

export interface EWayBillApplicabilityInput {
  orderType: string; // OrderType — only 'PRODUCT' can ever require one
  consignmentValue: number;
  thresholdAmount: number; // admin-configurable, see EWayBillService.getThreshold()
}

export function checkEWayBillApplicability(input: EWayBillApplicabilityInput): { required: boolean; reason: string } {
  if (input.orderType !== 'PRODUCT') return { required: false, reason: 'Not a goods movement (SERVICE order)' };
  if (input.consignmentValue <= input.thresholdAmount) return { required: false, reason: `Consignment value ₹${input.consignmentValue} is at/below the ₹${input.thresholdAmount} threshold` };
  return { required: true, reason: `Consignment value ₹${input.consignmentValue} exceeds the ₹${input.thresholdAmount} threshold` };
}

// ── Tax-config resolution — real Indian GST has different rate slabs (0/5/12/18/28%) by
// HSN/SAC, even within the same "SERVICE" or "PRODUCT" appliesTo scope (an AC repair and
// a basic cleaning visit legitimately carry different SAC codes and rates). The admin's
// own Taxes screen already lets multiple TaxConfig rows be entered per scope, each with
// its own hsnCode — this resolver is what actually differentiates between them by
// matching each line's own HSN/SAC, rather than blindly using one blanket rate for an
// entire scope (the previous behavior, and the exact gap the Taxes screen's own warning
// banner used to flag: "rates defined here are informational... integration with
// billing must be done in the order creation flow" — this IS that integration).
//
// Resolution order per line: (1) an explicit per-item override percent set on the
// Service/Product row itself wins outright; (2) an exact HSN/SAC match against an active
// TaxConfig row for this scope; (3) the first active TaxConfig row for this scope, as a
// blanket fallback (matches the Estimate Engine's existing "override wins, else first
// active row, else defaultWhenUnconfigured" pattern); (4) defaultWhenUnconfigured — 0 for
// ordinary services/products (never invent a rate nobody configured), but a real non-zero
// default is passed in for Remont's own platform fee (see PLATFORM_FEE_DEFAULT_RATE
// below), since that one has a well-established real-world rate.
export interface TaxRateResolver {
  // overridePercent accepts `any` because callers pass a Prisma Decimal directly
  // (Service/Product.gstOverridePercent) — Number() below handles it regardless.
  // categoryId is Phase 8's new optional 3rd resolution step (category-level default) —
  // every existing call site omits it and behaves identically to before.
  rateFor(hsnSac?: string | null, overridePercent?: any, categoryId?: string | null): number;
  // Phase 8 — whether the matched row's price is GST-inclusive or exclusive.
  // overrideInclusive accepts a Prisma-nullable boolean directly (Product.gstInclusive).
  priceTypeFor(hsnSac?: string | null, categoryId?: string | null, overrideInclusive?: boolean | null): 'INCLUSIVE' | 'EXCLUSIVE';
  defaultHsn: string | null;
}
export async function buildTaxRateResolver(
  prisma: any,
  appliesTo: 'SERVICE' | 'PRODUCT' | 'PLATFORM_FEE',
  defaultWhenUnconfigured = 0,
): Promise<TaxRateResolver> {
  const now = new Date();
  const rows = await prisma.taxConfig.findMany({
    where: {
      isActive: true, type: 'GST', appliesTo: { has: appliesTo },
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validTo: null }, { validTo: { gte: now } }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });
  const byHsn = new Map<string, any>();
  const byCategory = new Map<string, any>();
  for (const r of rows) {
    if (r.hsnCode) byHsn.set(r.hsnCode, r);
    else if (r.productCategoryId) byCategory.set(r.productCategoryId, r);
  }
  // "First active row for this scope" — unchanged fallback semantics (byte-for-byte the
  // same selection as before Phase 8), now also effective-dating-filtered above.
  const blanketRow = rows[0];

  function resolveRow(hsnSac?: string | null, categoryId?: string | null) {
    if (hsnSac && byHsn.has(hsnSac)) return byHsn.get(hsnSac);
    if (categoryId && byCategory.has(categoryId)) return byCategory.get(categoryId);
    return blanketRow;
  }

  return {
    rateFor(hsnSac, overridePercent, categoryId) {
      if (overridePercent !== undefined && overridePercent !== null) {
        const n = Number(overridePercent);
        if (!Number.isNaN(n)) return n;
      }
      const row = resolveRow(hsnSac, categoryId);
      if (!row) return defaultWhenUnconfigured;
      if (row.gstApplicable === false) return 0; // exempt — distinct from a genuine 0% NIL rate, but forces the same 0 here
      return Number(row.rate);
    },
    priceTypeFor(hsnSac, categoryId, overrideInclusive) {
      if (overrideInclusive !== undefined && overrideInclusive !== null) {
        return overrideInclusive ? 'INCLUSIVE' : 'EXCLUSIVE';
      }
      const row = resolveRow(hsnSac, categoryId);
      return row?.priceType === 'GST_INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE'; // default EXCLUSIVE preserves today's implicit behavior
    },
    defaultHsn: blanketRow?.hsnCode || null,
  };
}

// Phase 8 — single source of truth for splitting a product line's charged amount into its
// taxable base + GST component, honoring the resolved inclusive/exclusive treatment. Used
// by every PRODUCT checkout path (master-orders.module.ts, orders.module.ts) so they never
// each reimplement this split differently. `lineAmount` is always the amount actually
// charged for the line (unitPrice*qty) — for an INCLUSIVE line this IS the gross the tax
// gets backed out of; for an EXCLUSIVE line this is the pre-tax base tax gets added to.
export async function resolveProductGstLine(
  prodTax: TaxRateResolver,
  product: { hsnSac?: string | null; gstOverridePercent?: any; gstInclusive?: boolean | null; categoryId: string },
  lineAmount: number,
): Promise<{ taxableValue: number; gstAmount: number; ratePercent: number; inclusive: boolean }> {
  const ratePercent = prodTax.rateFor(product.hsnSac, product.gstOverridePercent, product.categoryId);
  const inclusive = prodTax.priceTypeFor(product.hsnSac, product.categoryId, product.gstInclusive) === 'INCLUSIVE';
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  if (ratePercent <= 0) {
    return { taxableValue: round2(lineAmount), gstAmount: 0, ratePercent: 0, inclusive };
  }
  if (inclusive) {
    const taxableValue = round2(lineAmount / (1 + ratePercent / 100));
    return { taxableValue, gstAmount: round2(lineAmount - taxableValue), ratePercent, inclusive };
  }
  return { taxableValue: round2(lineAmount), gstAmount: round2((lineAmount * ratePercent) / 100), ratePercent, inclusive };
}

// ─── Phase 3 — discount funding / GST / settlement consistency (C-02, C-03, M-04) ─────────
// Before this, a PRODUCT group's per-item GST/taxableValue snapshot (resolveProductGstLine()
// above) was always resolved BEFORE the checkout's coupon/membership discount was even known,
// then the discount was subtracted only from the final payable total — never from taxable
// value, never from the seller's settlement base (ProductLedgerService reads
// order.productsTaxableAmount directly). SERVICE lines don't have this problem (their GST
// was already computed on the discounted amount); PRODUCT lines did, silently, for every
// coupon, with no record of who was actually meant to bear that cost.
//
// The fix is opt-in per coupon (Coupon.fundedBy, default PLATFORM): a PLATFORM-funded
// discount (today's exact behaviour, unchanged) leaves every PRODUCT taxable value/GST/
// settlement figure exactly as before — deliberately, since whether a platform subsidy
// legally reduces GST taxable value is an open CA question (see the Phase 3 report), never
// guessed here. A SELLER-funded discount is a plain settlement fact, not a tax-law guess —
// the seller chose to give up that revenue — so it's safe to actually reduce the taxable
// base by the same ratio as the discount, which correctly reduces GST (C-02) and, because
// settlement is read from the same now-reduced order.productsTaxableAmount field, correctly
// reduces the seller's own settlement too (C-03) with no separate change needed in
// ProductLedgerService.

export interface ProductGstLineSnapshot {
  taxableValue?: number | null;
  gstAmount?: number | null;
}

/** Proportionally scales a PRODUCT group's already-resolved per-item GST snapshot down by
 * the group's own discount share — only ever called for a SELLER-funded coupon. Both the
 * inclusive and exclusive branches of resolveProductGstLine() are linear in lineAmount, so
 * scaling taxableValue and gstAmount by the same ratio is exactly equivalent to having
 * resolved GST against the discounted line amount in the first place — not an approximation.
 * Mutates nothing; returns the scaled aggregate + per-item values for the caller to persist.
 * `groupAmount` <= 0 or `groupDiscount` <= 0 is a no-op (ratio 1) — nothing to scale. */
export function applySellerFundedDiscountToProductGst<T extends ProductGstLineSnapshot>(
  items: T[],
  productsTaxableAmount: number,
  productGstOnTop: number,
  groupAmount: number,
  groupDiscount: number,
): { items: T[]; productsTaxableAmount: number; productGstOnTop: number; ratio: number } {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  if (groupAmount <= 0 || groupDiscount <= 0) {
    return { items, productsTaxableAmount, productGstOnTop, ratio: 1 };
  }
  const ratio = Math.max(0, 1 - groupDiscount / groupAmount);
  const scaledItems = items.map((it) => ({
    ...it,
    taxableValue: it.taxableValue != null ? round2(it.taxableValue * ratio) : it.taxableValue,
    gstAmount: it.gstAmount != null ? round2(it.gstAmount * ratio) : it.gstAmount,
  }));
  return {
    items: scaledItems,
    productsTaxableAmount: round2(productsTaxableAmount * ratio),
    productGstOnTop: round2(productGstOnTop * ratio),
    ratio,
  };
}

export type DiscountGstTreatment =
  | 'NOT_APPLICABLE_NO_DISCOUNT'
  | 'SERVICE_TAXABLE_VALUE_REDUCED_PRE_EXISTING'
  | 'TAXABLE_VALUE_REDUCED_SELLER_FUNDED'
  | 'NOT_REDUCED_PLATFORM_FUNDED_PENDING_CA_REVIEW'
  | 'MIXED_ORDER_SERVICE_COMPONENT_REDUCED_PRODUCT_COMPONENT_NOT';

/** Builds the Prisma create-data for one OrderDiscountAllocation row — the single place both
 * checkout paths (MasterOrdersService.checkout(), OrdersService.create()) construct this
 * record, so the gstTreatment/accountingTreatment vocabulary can never drift between them. */
export function buildDiscountAllocationData(input: {
  orderId: string;
  couponId?: string | null;
  sellerId?: string | null; // ProductVendor.id — null for a SERVICE order
  discountAmount: number;
  fundingSource: 'PLATFORM' | 'SELLER';
  isProductOrder: boolean;
  taxableValueAdjustment?: number; // pre-computed by applySellerFundedDiscountToProductGst() above, when relevant
  // Phase 3 — true only for OrdersService.create()'s legacy mixed service+product Order
  // shape (predates the Child-Order-split engine — every MasterOrdersService child Order
  // is strictly one type, so this is always omitted there): this order ALSO has a SERVICE
  // component whose own GST already reflects the discount (pre-existing, unconditional),
  // independent of whatever was decided for the PRODUCT component below.
  hasReducedServiceComponent?: boolean;
}) {
  const discountAmount = Math.round((input.discountAmount || 0) * 100) / 100;
  const hasDiscount = discountAmount > 0;
  const sellerFunded = hasDiscount && input.fundingSource === 'SELLER' && input.isProductOrder && !!input.sellerId;
  const mixedPartialReduction = hasDiscount && input.isProductOrder && !sellerFunded && !!input.hasReducedServiceComponent;

  let gstTreatment: DiscountGstTreatment = 'NOT_APPLICABLE_NO_DISCOUNT';
  if (hasDiscount) {
    if (!input.isProductOrder) gstTreatment = 'SERVICE_TAXABLE_VALUE_REDUCED_PRE_EXISTING';
    else if (sellerFunded) gstTreatment = 'TAXABLE_VALUE_REDUCED_SELLER_FUNDED';
    else if (mixedPartialReduction) gstTreatment = 'MIXED_ORDER_SERVICE_COMPONENT_REDUCED_PRODUCT_COMPONENT_NOT';
    else gstTreatment = 'NOT_REDUCED_PLATFORM_FUNDED_PENDING_CA_REVIEW';
  }
  const accountingTreatment = !hasDiscount ? 'NONE' : sellerFunded ? 'SELLER_BORNE_PRICE_REDUCTION' : 'PLATFORM_MARKETING_EXPENSE';
  const taxableValueAdjustment = sellerFunded ? Math.round((input.taxableValueAdjustment || 0) * 100) / 100 : 0;

  return {
    orderId: input.orderId,
    couponId: input.couponId || undefined,
    sellerId: input.sellerId || undefined,
    customerDiscountAmount: discountAmount,
    // Reflects what ACTUALLY happened, not merely what the coupon was configured as — a
    // coupon flagged SELLER but left unattributable (e.g. a multi-vendor cart with no
    // single seller to charge) is recorded as PLATFORM here, matching taxableValueReduced/
    // settlementImpact below; a report filtering fundingSource='SELLER' should only ever
    // return orders where a seller genuinely bore the cost.
    fundingSource: (!input.isProductOrder ? 'PLATFORM' : (sellerFunded ? 'SELLER' : 'PLATFORM')) as 'PLATFORM' | 'SELLER',
    fundedAmount: discountAmount,
    taxableValueReduced: !input.isProductOrder ? hasDiscount : (sellerFunded || mixedPartialReduction),
    taxableValueAdjustment,
    settlementImpact: sellerFunded ? -taxableValueAdjustment : 0,
    gstTreatment,
    accountingTreatment,
  };
}

/** Proportionally distributes a known total discount across a set of already-priced invoice
 * lines by each line's own gross share (qty*rate), last line absorbing the rounding
 * remainder — same allocation idiom as MasterOrdersService.allocateAcrossGroups(). Only call
 * this when the discount is known to legitimately reduce THIS invoice's taxable value (see
 * OrderDiscountAllocation.taxableValueReduced) — for the non-reducing case the discount
 * belongs in buildInvoiceBreakdown()'s top-level `discount` input instead, which nets it out
 * of the total post-tax without touching any line. */
export function distributeInvoiceDiscount(lines: BillingLineInput[], totalDiscount: number): BillingLineInput[] {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  if (totalDiscount <= 0 || !lines.length) return lines;
  const gross = lines.map((l) => l.qty * l.rate);
  const grossSum = gross.reduce((s, g) => s + g, 0);
  if (grossSum <= 0) return lines;
  const shares = gross.map((g) => round2((g / grossSum) * totalDiscount));
  const allocated = shares.reduce((s, a) => s + a, 0);
  shares[shares.length - 1] = round2(shares[shares.length - 1] + (totalDiscount - allocated));
  return lines.map((l, i) => ({ ...l, discount: round2((l.discount || 0) + Math.min(Math.max(shares[i], 0), gross[i])) }));
}

// SAC 999799 ("Other services n.e.c." / business auxiliary services) is the real-world
// classification both Ola's convenience fee and Urban Company's platform fee use — both
// reference invoices in the billing spec show it taxed flat at 18%. Used as the
// fallback rate for Remont's own platform-fee/marketplace-commission invoices only when
// no admin-configured PLATFORM_FEE TaxConfig row overrides it — unlike ordinary
// services/products, 0% would be actively wrong here, not just unconfigured.
export const PLATFORM_FEE_DEFAULT_RATE = 18;
export const PLATFORM_FEE_DEFAULT_SAC = '999799';

// Remont's own invoicing-entity details — admin-editable via the existing generic Site
// Settings screen (group: 'billing'), same DB-overrides-defaults pattern already used for
// Razorpay keys (payments.module.ts). Defaults to the reference invoice's real details so
// invoicing works out of the box even before an admin visits the settings screen.
export interface BillingCompanyConfig {
  legalName: string; gstin: string; state: string; address: string;
  mobile: string; email: string; website: string;
  bankName: string; bankIfsc: string; bankAccountNumber: string;
  invoiceTerms: string[];
}
const BILLING_CONFIG_DEFAULTS: BillingCompanyConfig = {
  legalName: 'REMONT INDIA PRIVATE LIMITED',
  gstin: '23AAKCR9036L1ZY',
  state: 'Madhya Pradesh',
  address: '5/6 Amer Complex, MP Nagar Zone-2, Bhopal, Bhopal, Madhya Pradesh, 462011',
  mobile: '9425330195',
  email: 'contact@remontindia.com',
  website: 'www.remontindia.com',
  bankName: 'Karnataka Bank, Bhopal',
  bankIfsc: 'KARB0000127',
  bankAccountNumber: '1272000100072001',
  invoiceTerms: [
    'This is a computer-generated invoice and is valid without a physical signature.',
    'Payment is due immediately upon receipt unless otherwise agreed in writing.',
    'Any dispute regarding this invoice is subject to the jurisdiction of Bhopal courts only.',
    'GST as applicable has been charged only on Remont India Private Limited’s own taxable supply, as itemized above.',
  ],
};
export async function getBillingCompanyConfig(prisma: any): Promise<BillingCompanyConfig> {
  const rows = await prisma.siteSetting.findMany({ where: { group: 'billing' } });
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  const gstin = map.company_gstin || BILLING_CONFIG_DEFAULTS.gstin;
  return {
    legalName: map.company_legal_name || BILLING_CONFIG_DEFAULTS.legalName,
    gstin,
    // The GSTIN's own state prefix is authoritative once a GSTIN is set — prevents the
    // registered state silently drifting out of sync with an admin-edited GSTIN.
    state: stateFromGstin(gstin) || map.company_state || BILLING_CONFIG_DEFAULTS.state,
    address: map.company_address || BILLING_CONFIG_DEFAULTS.address,
    mobile: map.company_mobile || BILLING_CONFIG_DEFAULTS.mobile,
    email: map.company_email || BILLING_CONFIG_DEFAULTS.email,
    website: map.company_website || BILLING_CONFIG_DEFAULTS.website,
    bankName: map.company_bank_name || BILLING_CONFIG_DEFAULTS.bankName,
    bankIfsc: map.company_ifsc || BILLING_CONFIG_DEFAULTS.bankIfsc,
    bankAccountNumber: map.company_account_number || BILLING_CONFIG_DEFAULTS.bankAccountNumber,
    invoiceTerms: map.invoice_terms ? map.invoice_terms.split('\n').map((s) => s.trim()).filter(Boolean) : BILLING_CONFIG_DEFAULTS.invoiceTerms,
  };
}

// Vendor "skills" have been entered through at least two different UIs with different
// vocabularies (a legacy category picker using names like ELECTRICIAN/PLUMBER/CIVIL, and
// free-text/seed data using lowercase-hyphenated slugs like "plumbing"/"pest-control")
// that never matched real ServiceCategory.key values (PLUMBING, ELECTRICAL, PEST_CONTROL,
// RENOVATION, CONSTRUCTION, ...). DispatchService's vendor matching does an exact-match
// `skills: { has: categoryKey }` lookup, so any mismatch here means that vendor is silently
// never found for that category. This normalizes a raw skill value onto the real key space.
const SKILL_KEY_ALIASES: Record<string, string> = {
  PLUMBER: 'PLUMBING',
  ELECTRICIAN: 'ELECTRICAL',
  CIVIL: 'CONSTRUCTION',
  PEST: 'PEST_CONTROL',
};
export function normalizeSkillKey(raw: string): string {
  const key = String(raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return SKILL_KEY_ALIASES[key] || key;
}

// Re-export filter and interceptor with file-aliased names for main.ts
export { HttpExceptionFilter as DefaultExceptionFilter };
export { TransformInterceptor as DefaultTransformInterceptor };
