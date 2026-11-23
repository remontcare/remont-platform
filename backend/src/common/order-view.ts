import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * The partner's public ID — what the partner shows on their ID card and the customer sees on
 * their booking. Derived from the permanent ServiceVendor.id (a cuid whose tail is random), so
 * it never changes, needs no stored column, and is computed only here.
 * Example: RP-K3J9-X2QA.
 */
export function partnerCodeOf(vendorId: string): string {
  const tail = vendorId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase().padStart(8, '0');
  return `RP-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

/** Job evidence: before/after photos the partner takes on site. */
const EVIDENCE_KEYS = ['photosBefore', 'photosAfter'] as const;

/**
 * Roles that may see job evidence: Remont's team (to inspect disputes) and service partners
 * (their own jobs). Everyone else — customers, sellers, delivery partners, public tracking
 * links — never receives it; the team shares it with a customer during a dispute.
 */
const EVIDENCE_VISIBLE_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.CRM_AGENT, UserRole.SERVICE_VENDOR]);

function isPlainObject(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null; // skips Date, Decimal, Buffer, streams…
}

/**
 * Shapes order data in a response, in place:
 *  - every order row's assigned partner (`order.vendor`, always a ServiceVendor) gets its `partnerCode`;
 *  - job evidence is removed unless [canSeeEvidence]. A partner who booked as a customer
 *    (subtree whose customerId is the caller) is treated as that customer there.
 */
export function shapeOrderView(value: any, opts: { canSeeEvidence: boolean; callerId?: string }, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) shapeOrderView(item, opts, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;

  let o = opts;
  if (o.canSeeEvidence && o.callerId && value.customerId === o.callerId) o = { ...o, canSeeEvidence: false };
  if (!o.canSeeEvidence) for (const k of EVIDENCE_KEYS) if (k in value) delete value[k];

  if ('orderNumber' in value && isPlainObject(value.vendor) && typeof value.vendor.id === 'string') {
    value.vendor.partnerCode = partnerCodeOf(value.vendor.id);
  }
  for (const key of Object.keys(value)) shapeOrderView(value[key], o, depth + 1);
}

/** Applied to every response, so a new endpoint returning an order can't leak job evidence. */
@Injectable()
export class OrderViewInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest().user;
    const opts = { canSeeEvidence: !!user?.sub && EVIDENCE_VISIBLE_ROLES.has(user.role), callerId: user?.sub };
    return next.handle().pipe(map((data) => { shapeOrderView(data, opts); return data; }));
  }
}

/**
 * The assigned partner as a customer sees them on a booking — name, photo, rating, experience
 * and phone (to coordinate the visit). `partnerCode` is added by [shapeOrderView].
 */
export const CUSTOMER_PARTNER_SELECT = {
  id: true, fullName: true, photoUrl: true, rating: true, completedJobs: true, experienceYears: true, skills: true,
  user: { select: { name: true, phone: true } },
} as const;
