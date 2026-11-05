import {
  Module, Injectable, Controller, Get, Put, Delete, Body, Param, UseGuards, Logger,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, EXTRA_WORK_ITEM_PUBLIC_SELECT } from '../../common';
import { samePhone } from '../../common/phone';

/**
 * Order-scoped Authorized Person — someone the customer nominates at booking (e.g. a family
 * member at home) to handle service approvals for that one order. They sign in with their own
 * phone + OTP through the normal login; access is granted only by an ACTIVE, unexpired
 * OrderAuthorizedPerson row whose phone matches the phone in their JWT, and only to that order.
 * It never grants anything on the customer's account (history, addresses, wallet, payments).
 */

export const AUTHORIZED_PERSON_PERMISSIONS = {
  VIEW_ORDER: 'VIEW_ORDER',
  DECIDE_EXTRA_WORK: 'DECIDE_EXTRA_WORK',
} as const;
type Permission = typeof AUTHORIZED_PERSON_PERMISSIONS[keyof typeof AUTHORIZED_PERSON_PERMISSIONS];

/** How long after the booked slot (or booking time) the authorization stays usable. */
const AUTHORIZATION_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
/** Orders that are over — no new authorization can be added to them. */
const CLOSED_ORDER_STATUSES = ['COMPLETED', 'INVOICED', 'CLOSED', 'CANCELLED', 'REFUNDED'];

export class AuthorizedPersonDto {
  @IsString() @MaxLength(80) name: string;
  @IsString() @MaxLength(20) phone: string;
  @IsOptional() @IsString() @MaxLength(40) relationship?: string;
  /** "Authorize this person to manage service-related approvals for this order." */
  @IsBoolean() consent: boolean;
}

/** What an authorized person may see of the order — service details only, nothing from the
 *  customer's account (no customer contact, payments, invoices, OTPs or wallet). */
const AUTHORIZED_ORDER_SELECT = {
  id: true, orderNumber: true, status: true, type: true, slotStart: true, slotEnd: true,
  serviceAmount: true, extraWorkAmount: true, subtotal: true, gstAmount: true, totalAmount: true, createdAt: true,
  service: { select: { name: true } },
  serviceItems: { select: { service: { select: { name: true } } } },
  address: { select: { fullAddress: true, city: true, pincode: true } },
  vendor: { select: { fullName: true, photoUrl: true, user: { select: { name: true } } } },
  extraWorkItems: { select: EXTRA_WORK_ITEM_PUBLIC_SELECT, orderBy: { createdAt: 'asc' as const } },
};

/** "+91XXXXXXXXXX" for a valid Indian mobile, else null. */
export function normalizeIndianMobile(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  const national = digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

@Injectable()
export class AuthorizedPersonService {
  private readonly logger = new Logger(AuthorizedPersonService.name);
  constructor(private prisma: PrismaService) {}

  private validated(input: AuthorizedPersonDto) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) throw new BadRequestException('Authorized person name is required');
    const phone = normalizeIndianMobile(input.phone);
    if (!phone) throw new BadRequestException('Enter a valid 10-digit mobile number for the authorized person');
    if (input.consent !== true) throw new BadRequestException('Please confirm you authorize this person for this order');
    const relationship = typeof input.relationship === 'string' && input.relationship.trim() ? input.relationship.trim() : null;
    return { name, phone, relationship };
  }

  private async upsertForOrder(order: { id: string; customerId: string; slotStart: Date | null }, data: { name: string; phone: string; relationship: string | null }) {
    const expiresAt = new Date((order.slotStart?.getTime() ?? Date.now()) + AUTHORIZATION_VALIDITY_MS);
    return this.prisma.orderAuthorizedPerson.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, customerId: order.customerId, ...data, expiresAt },
      update: { ...data, status: 'ACTIVE', revokedAt: null, expiresAt },
    });
  }

  /**
   * Called by the booking endpoints right after an order is created. A missing input is a
   * no-op (existing bookings are unchanged). Applies to every service order of the booking —
   * one order, or the service child orders of a master (cart) order.
   */
  async attachFromBooking(target: { orderId?: string; masterOrderId?: string }, input?: AuthorizedPersonDto | null) {
    if (!input) return 0;
    const data = this.validated(input);
    const where = target.orderId ? { id: target.orderId } : target.masterOrderId ? { masterOrderId: target.masterOrderId } : null;
    if (!where) return 0;
    const orders = await this.prisma.order.findMany({
      where: { ...where, serviceId: { not: null } },
      select: { id: true, customerId: true, slotStart: true },
    });
    for (const o of orders) await this.upsertForOrder(o, data);
    return orders.length;
  }

  /** Booking endpoints call this BEFORE creating the order, so bad input never leaves an order behind. */
  assertValid(input: AuthorizedPersonDto) {
    this.validated(input);
  }

  /**
   * Booking endpoints call this AFTER the order exists. The order is already placed (and maybe
   * paid for), so a failure here must not fail the booking — it is logged and reported as
   * `authorizedPerson.saved: false` for the customer to retry from the order page.
   */
  async attachSafely<T extends object>(result: T, target: { orderId?: string; masterOrderId?: string }, input?: AuthorizedPersonDto | null): Promise<T> {
    if (!input) return result;
    try {
      const count = await this.attachFromBooking(target, input);
      return { ...result, authorizedPerson: { saved: count > 0 } };
    } catch (e) {
      this.logger.error(`Authorized person not saved for ${target.orderId || target.masterOrderId}: ${e.message}`);
      return { ...result, authorizedPerson: { saved: false } };
    }
  }

  /** Customer adds or replaces the authorized person on their own open order. */
  async setForOrder(customer: JwtPayload, orderId: string, input: AuthorizedPersonDto) {
    const data = this.validated(input);
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, customerId: true, slotStart: true, status: true, serviceId: true } });
    if (!order || order.customerId !== customer.sub) throw new NotFoundException('Order not found');
    if (!order.serviceId) throw new BadRequestException('An authorized person can only be added to a service order');
    if (CLOSED_ORDER_STATUSES.includes(order.status)) throw new BadRequestException('This order is already closed');
    const rec = await this.upsertForOrder(order, data);
    return this.publicView(rec);
  }

  /** Customer removes the authorization — it stops working immediately. */
  async revoke(customer: JwtPayload, orderId: string) {
    const rec = await this.prisma.orderAuthorizedPerson.findUnique({ where: { orderId } });
    if (!rec || rec.customerId !== customer.sub) throw new NotFoundException('No authorized person on this order');
    const updated = await this.prisma.orderAuthorizedPerson.update({ where: { orderId }, data: { status: 'REVOKED', revokedAt: new Date() } });
    return this.publicView(updated);
  }

  /**
   * The authorization that lets `phone` act on `orderId` with `permission`, or null. Every
   * access decision goes through here: ACTIVE, not expired, same order, same phone.
   */
  async activeFor(orderId: string, phone: string | undefined | null, permission: Permission) {
    if (!phone) return null;
    const rec = await this.activeForOrder(orderId, permission);
    return rec && samePhone(phone, rec.phone) ? rec : null;
  }

  /** The order's usable authorization (whoever it names), e.g. to notify them. */
  async activeForOrder(orderId: string, permission: Permission) {
    const rec = await this.prisma.orderAuthorizedPerson.findUnique({ where: { orderId } });
    if (!rec || rec.status !== 'ACTIVE') return null;
    if (rec.expiresAt && rec.expiresAt.getTime() <= Date.now()) return null;
    return rec.permissions.includes(permission) ? rec : null;
  }

  /** GET /authorized-orders — only orders this phone is currently authorized for. */
  async listForPhone(phone: string | undefined) {
    const normalized = normalizeIndianMobile(phone);
    if (!normalized) return [];
    const recs = await this.prisma.orderAuthorizedPerson.findMany({
      where: {
        phone: normalized, status: 'ACTIVE',
        permissions: { has: AUTHORIZED_PERSON_PERMISSIONS.VIEW_ORDER },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { order: { select: AUTHORIZED_ORDER_SELECT } },
    });
    return recs.map((r) => ({ authorization: this.publicView(r), order: r.order }));
  }

  /** GET /authorized-orders/:orderId — not-authorized and not-found look the same (no IDOR oracle). */
  async getForPhone(phone: string | undefined, orderId: string) {
    const rec = await this.activeFor(orderId, phone, AUTHORIZED_PERSON_PERMISSIONS.VIEW_ORDER);
    if (!rec) throw new NotFoundException('Order not found');
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: AUTHORIZED_ORDER_SELECT });
    if (!order) throw new NotFoundException('Order not found');
    return { authorization: this.publicView(rec), order };
  }

  private publicView(rec: { orderId: string; name: string; phone: string; relationship: string | null; status: string; permissions: string[]; expiresAt: Date | null }) {
    const { orderId, name, phone, relationship, status, permissions, expiresAt } = rec;
    return { orderId, name, phone, relationship, status, permissions, expiresAt };
  }
}

@ApiTags('Authorized Person')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class AuthorizedPersonController {
  constructor(private svc: AuthorizedPersonService) {}

  // The authorized person's view, keyed purely by the phone in their OTP-issued JWT.
  @Get('authorized-orders') list(@CurrentUser() u: JwtPayload) { return this.svc.listForPhone(u.phone); }
  @Get('authorized-orders/:orderId') one(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) { return this.svc.getForPhone(u.phone, id); }

  // The customer manages the authorization on their own order.
  @Put('orders/:orderId/authorized-person') set(@CurrentUser() u: JwtPayload, @Param('orderId') id: string, @Body() dto: AuthorizedPersonDto) {
    return this.svc.setForOrder(u, id, dto);
  }
  @Delete('orders/:orderId/authorized-person') revoke(@CurrentUser() u: JwtPayload, @Param('orderId') id: string) {
    return this.svc.revoke(u, id);
  }
}

@Module({
  controllers: [AuthorizedPersonController],
  providers: [AuthorizedPersonService],
  exports: [AuthorizedPersonService],
})
export class AuthorizedPersonModule {}
