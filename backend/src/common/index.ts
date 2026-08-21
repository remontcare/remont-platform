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
import { UserRole, FulfillmentType, MemberStatus } from '@prisma/client';

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
  calculateInvoice, stateFromGstin,
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
}

export function buildInvoiceBreakdown(input: InvoiceBuildInput, invoiceSeq: number) {
  const invoiceNumber = `INV-${input.orderNumber}-${(invoiceSeq + 1).toString().padStart(4, '0')}`;

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

  return {
    invoiceNumber,
    transactionType: input.transactionType,
    placeOfSupply: input.placeOfSupply,
    supplierState: input.customerSupplierState ?? input.remontState,
    supplierGstin: input.customerSupplierGstin ?? input.remontGstin,

    customerSubtotal: customer.taxableValue,
    customerCgst: customer.cgst,
    customerSgst: customer.sgst,
    customerIgst: customer.igst,
    customerTotal: customer.total,

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

    discount: 0,
    roundOff: customer.roundOff,
    // Cast to `any` — Prisma's generated JsonValue input type can't structurally match a
    // typed interface array even though this is plain, JSON-serializable data.
    lineItemsSnapshot: { customer: customer.lines, vendor: vendor?.lines ?? [], remont: remont.lines } as any,
  };
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
  rateFor(hsnSac?: string | null, overridePercent?: any): number;
  defaultHsn: string | null;
}
export async function buildTaxRateResolver(
  prisma: any,
  appliesTo: 'SERVICE' | 'PRODUCT' | 'PLATFORM_FEE',
  defaultWhenUnconfigured = 0,
): Promise<TaxRateResolver> {
  const rows = await prisma.taxConfig.findMany({
    where: { isActive: true, type: 'GST', appliesTo: { has: appliesTo } },
    orderBy: { createdAt: 'asc' },
  });
  const byHsn = new Map<string, number>();
  for (const r of rows) if (r.hsnCode) byHsn.set(r.hsnCode, Number(r.rate));
  const defaultRow = rows[0];
  const blanketRate = defaultRow ? Number(defaultRow.rate) : defaultWhenUnconfigured;
  return {
    rateFor(hsnSac, overridePercent) {
      if (overridePercent !== undefined && overridePercent !== null) {
        const n = Number(overridePercent);
        if (!Number.isNaN(n)) return n;
      }
      if (hsnSac && byHsn.has(hsnSac)) return byHsn.get(hsnSac)!;
      return blanketRate;
    },
    defaultHsn: defaultRow?.hsnCode || null,
  };
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
