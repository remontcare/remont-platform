import {
  createParamDecorator, ExecutionContext, SetMetadata,
  Injectable, CanActivate, ForbiddenException, UnauthorizedException,
  ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger,
  NestInterceptor, CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { UserRole } from '@prisma/client';

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

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Shared GST invoice math — previously copy-pasted verbatim in three places
// (InvoicesService.generate(), OrdersService.autoGenerateInvoice(), AdminService.autoGenerateInvoice()).
// Pure function: callers fetch the Order + approved ExtraWorkItems and the current
// Invoice count (for numbering), everything else is deterministic arithmetic.
export interface InvoiceBreakdownInput {
  orderNumber: string;
  subtotal: number;
  totalAmount: number;
  gstAmount: number;
  serviceAmount: number;
  remontCommission: number;
  approvedExtraWorkAmount: number;
}

export function computeInvoiceBreakdown(input: InvoiceBreakdownInput, invoiceSeq: number, bookingFee = 49) {
  const customerSubtotal = input.subtotal;
  const customerTotal = input.totalAmount;
  const customerCgst = Math.round((input.gstAmount / 2) * 100) / 100;
  const customerSgst = customerCgst;

  const vendorLabor = input.serviceAmount + input.approvedExtraWorkAmount;
  const vendorMaterial = 0;
  const vendorPretax = vendorLabor + vendorMaterial;
  const vendorCgst = Math.round(vendorPretax * 0.09 * 100) / 100;
  const vendorSgst = vendorCgst;
  const vendorTotal = vendorPretax + vendorCgst + vendorSgst;

  const platformCommission = input.remontCommission;
  const remontPretax = platformCommission + bookingFee;
  const remontCgst = Math.round(remontPretax * 0.09 * 100) / 100;
  const remontSgst = remontCgst;
  const remontTotal = remontPretax + remontCgst + remontSgst;

  const invoiceNumber = `INV-${input.orderNumber}-${(invoiceSeq + 1).toString().padStart(4, '0')}`;

  return {
    invoiceNumber,
    customerSubtotal, customerCgst, customerSgst, customerTotal,
    vendorLabor, vendorMaterial, vendorCgst, vendorSgst, vendorTotal,
    platformCommission, bookingFee, remontCgst, remontSgst, remontTotal,
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
