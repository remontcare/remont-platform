import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards, Logger,
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsArray, IsIn, IsOptional, IsString, IsNumber, IsEmail, IsEnum, IsDateString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import * as crypto from 'crypto';
import { BookingChannel, MasterOrderStatus, OrderStatus, OrderType, PaymentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, addressSnapshotFields, writeOtpLog, resolveCommission } from '../../common';
import { CouponsService, CouponsModule } from '../coupons/coupons.module';
import { MembershipsService, MembershipsModule } from '../memberships/memberships.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { DispatchService, RoutingService, OrdersModule } from '../orders/orders.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';

// ─── Pure functions (no DB) — unit-tested directly, see master-orders.split.spec.ts ───

export type SplitCartItem =
  | { type: 'SERVICE'; serviceId: string; quantity: number }
  | { type: 'PRODUCT'; productId: string; vendorId: string | null; quantity: number };

export type SplitGroup =
  | { type: 'SERVICE'; serviceId: string; quantity: number }
  | { type: 'PRODUCT'; vendorId: string | null; items: { productId: string; quantity: number }[] };

// Splits a mixed cart by the priority the product requires: category is a property of
// serviceId (each service belongs to exactly one category), so grouping by distinct
// serviceId already keeps a category together whenever only one service in it was picked,
// while correctly giving each *distinct* service its own child order otherwise — matching
// the real schema constraint (Order.serviceId is a single scalar, one service per Order)
// instead of the current frontend behavior, which silently drops every service but the
// first when a category group has more than one. Products are grouped by distinct
// Product.vendorId — the one genuinely new splitting axis, since nothing does this today.
export function groupCartForSplit(items: SplitCartItem[]): SplitGroup[] {
  const serviceQty = new Map<string, number>();
  const productsByVendor = new Map<string, Map<string, number>>();

  for (const item of items) {
    if (item.type === 'SERVICE') {
      serviceQty.set(item.serviceId, (serviceQty.get(item.serviceId) || 0) + (item.quantity || 1));
    } else {
      const vendorKey = item.vendorId || '__unassigned__';
      if (!productsByVendor.has(vendorKey)) productsByVendor.set(vendorKey, new Map());
      const perVendor = productsByVendor.get(vendorKey)!;
      perVendor.set(item.productId, (perVendor.get(item.productId) || 0) + (item.quantity || 1));
    }
  }

  const groups: SplitGroup[] = [];
  for (const [serviceId, quantity] of serviceQty) {
    groups.push({ type: 'SERVICE', serviceId, quantity });
  }
  for (const [vendorKey, productQty] of productsByVendor) {
    groups.push({
      type: 'PRODUCT',
      vendorId: vendorKey === '__unassigned__' ? null : vendorKey,
      items: Array.from(productQty, ([productId, quantity]) => ({ productId, quantity })),
    });
  }
  return groups;
}

// Pro-rata allocation of one master-level amount (discount, GST, wallet) across child
// groups by their share of the combined subtotal — guarantees the allocations sum to
// exactly `total` (the last group absorbs the rounding remainder) so per-child math never
// silently drifts from what the customer was actually charged.
export function allocateAcrossGroups(groupAmounts: number[], subtotal: number, total: number): number[] {
  if (!groupAmounts.length) return [];
  if (subtotal <= 0 || total === 0) return groupAmounts.map(() => 0);
  const allocations = groupAmounts.map((amt) => Math.round((amt / subtotal) * total * 100) / 100);
  const allocatedSum = allocations.reduce((s, a) => s + a, 0);
  const remainder = Math.round((total - allocatedSum) * 100) / 100;
  allocations[allocations.length - 1] = Math.round((allocations[allocations.length - 1] + remainder) * 100) / 100;
  return allocations;
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'INVOICED', 'CLOSED']);
const CANCELLED_STATUSES = new Set(['CANCELLED', 'REFUNDED']);

// The Master Order's aggregate status, computed live from its children's existing
// OrderStatus values — never persisted as a second source of truth, so it can't drift.
// Per-category workflow *definitions* are out of scope (deferred Fulfillment/Workflow
// Engine); this only answers "what's the overall picture" for tracking/admin views.
export function deriveMasterProgress(childStatuses: string[]): string {
  if (!childStatuses.length) return 'PENDING_PAYMENT';
  if (childStatuses.some((s) => s === 'PENDING_PAYMENT')) return 'PENDING_PAYMENT';
  if (childStatuses.every((s) => CANCELLED_STATUSES.has(s))) return 'CANCELLED';
  const active = childStatuses.filter((s) => !CANCELLED_STATUSES.has(s));
  if (active.length && active.every((s) => TERMINAL_STATUSES.has(s))) return 'COMPLETED';
  if (active.some((s) => TERMINAL_STATUSES.has(s))) return 'PARTIALLY_COMPLETED';
  return 'IN_PROGRESS';
}

// ─── DTOs ───

export class MasterCheckoutItemDto {
  @IsIn(['SERVICE', 'PRODUCT']) type: 'SERVICE' | 'PRODUCT';
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsNumber() @Min(1) quantity?: number;
}

class InlineAddressDto {
  @IsOptional() @IsString() label?: string;
  @IsString() fullAddress: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
}

export class CreateMasterOrderDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => MasterCheckoutItemDto) items: MasterCheckoutItemDto[];
  @IsOptional() @IsEnum(BookingChannel) channel?: BookingChannel;
  @IsOptional() @IsString() addressId?: string;
  @IsOptional() @ValidateNested() @Type(() => InlineAddressDto) inlineAddress?: InlineAddressDto;
  @IsOptional() @IsDateString() slotStart?: string;
  @IsOptional() @IsDateString() slotEnd?: string;
  @IsOptional() @IsString() couponCode?: string;
  @IsOptional() @IsNumber() @Min(0) walletAmount?: number;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() gstBusinessName?: string;
}

export class PublicMasterCheckoutDto {
  @IsString() name: string;
  @IsString() phone: string;
  @IsOptional() @IsEmail() email?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => MasterCheckoutItemDto) items: MasterCheckoutItemDto[];
  @IsOptional() @IsEnum(BookingChannel) channel?: BookingChannel;
  @IsString() fullAddress: string;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsString() landmark?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsDateString() slotStart?: string;
  @IsOptional() @IsDateString() slotEnd?: string;
  @IsOptional() @IsString() couponCode?: string;
  @IsOptional() @IsNumber() @Min(0) walletAmount?: number;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() gstBusinessName?: string;
  @IsIn(['ONLINE', 'COD']) paymentMethod: 'ONLINE' | 'COD';
}

interface CheckoutOpts {
  customerId?: string;
  guestName?: string;
  guestPhone?: string;
  guestEmail?: string;
  paymentMethod?: 'ONLINE' | 'COD';
}

interface PricedGroup {
  type: 'SERVICE' | 'PRODUCT';
  amount: number;
  serviceId?: string;
  quantity?: number;
  vendorId?: string | null;
  items?: { productId: string; quantity: number; unitPrice: number; totalPrice: number }[];
}

// ─── Service ───
@Injectable()
export class MasterOrdersService {
  private readonly logger = new Logger(MasterOrdersService.name);
  constructor(
    private prisma: PrismaService,
    private coupons: CouponsService,
    private memberships: MembershipsService,
    private cities: CitiesService,
    private payments: PaymentsService,
    private dispatch: DispatchService,
    private routing: RoutingService,
    private paymentNotify: PaymentNotificationsService,
  ) {}

  private async debitWalletForOrder(customerId: string, amount: number, masterOrderId: string, masterOrderNumber: string) {
    const user = await this.prisma.user.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
    if (!user || Number(user.walletBalance) < amount) throw new BadRequestException('Insufficient wallet balance');
    const newBalance = Number(user.walletBalance) - amount;
    await this.prisma.user.update({ where: { id: customerId }, data: { walletBalance: { decrement: amount } } });
    await this.prisma.walletTransaction.create({
      data: {
        userId: customerId, type: 'DEBIT', reason: 'ORDER_PAYMENT', amount, balanceAfter: newBalance,
        orderId: masterOrderId, notes: `Payment for order ${masterOrderNumber}`,
      },
    });
  }

  async generateMasterOrderNumber(): Promise<string> {
    const now = new Date();
    const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const countToday = await this.prisma.masterOrder.count({ where: { createdAt: { gte: startOfDay } } });
    const seq = String(countToday + 1).padStart(3, '0');
    return `RM${ymd}${seq}`;
  }

  // The Child Order Engine: one cart, one checkout, one payment, one order number for the
  // customer — internally splits into one Order per distinct service and one Order per
  // distinct product seller, all linked under one MasterOrder.
  async checkout(dto: CreateMasterOrderDto, opts: CheckoutOpts) {
    if (!dto.items?.length) throw new BadRequestException('Cart is empty');

    // Resolve customer — authenticated customerId, or guest find-or-create by phone
    // (same pattern as GuestBookingService.book() in orders.module.ts).
    let customerId = opts.customerId;
    if (!customerId) {
      if (!opts.guestPhone || !opts.guestName) throw new BadRequestException('Name and phone required for guest checkout');
      let user = await this.prisma.user.findUnique({ where: { phone: opts.guestPhone } });
      if (!user) {
        user = await this.prisma.user.create({
          data: { phone: opts.guestPhone, name: opts.guestName, email: opts.guestEmail || undefined, role: UserRole.CUSTOMER, isVerified: false },
        });
      }
      customerId = user.id;
    }

    let orderCityId: string | null = null;
    if (dto.city) {
      const cityRow = await this.cities.getByName(dto.city);
      if (cityRow && !cityRow.isActive) throw new BadRequestException(`${cityRow.name} is not currently accepting orders`);
      orderCityId = cityRow?.id || null;
    }

    // Fetch + validate every referenced service/product once
    const serviceIds = Array.from(new Set(dto.items.filter((i) => i.type === 'SERVICE').map((i) => i.serviceId).filter(Boolean))) as string[];
    const productIds = Array.from(new Set(dto.items.filter((i) => i.type === 'PRODUCT').map((i) => i.productId).filter(Boolean))) as string[];
    const [services, products] = await Promise.all([
      this.prisma.service.findMany({ where: { id: { in: serviceIds } } }),
      this.prisma.product.findMany({ where: { id: { in: productIds } } }),
    ]);
    const serviceMap = new Map(services.map((s) => [s.id, s]));
    const productMap = new Map(products.map((p) => [p.id, p]));

    const splitItems: SplitCartItem[] = [];
    for (const item of dto.items) {
      if (item.type === 'SERVICE') {
        const svc = item.serviceId ? serviceMap.get(item.serviceId) : undefined;
        if (!svc || !svc.isActive) throw new NotFoundException(`Service not found or inactive: ${item.serviceId}`);
        splitItems.push({ type: 'SERVICE', serviceId: svc.id, quantity: item.quantity || 1 });
      } else {
        const p = item.productId ? productMap.get(item.productId) : undefined;
        if (!p || !p.isActive) throw new NotFoundException(`Product not found or inactive: ${item.productId}`);
        splitItems.push({ type: 'PRODUCT', productId: p.id, vendorId: p.vendorId, quantity: item.quantity || 1 });
      }
    }

    const groups = groupCartForSplit(splitItems);
    if (!groups.length) throw new BadRequestException('No valid items to order');

    // Price each group — mirrors OrdersService.create()'s per-item pricing exactly
    // (city price override for services, Product.price * qty for products), applied once
    // per group instead of once for the whole cart.
    const cityPriceCache = new Map<string, number | null>();
    const commissionByService = new Map<string, { commissionAmount: number; ruleId: string | null; ruleLabel: string }>();
    const pricedGroups: PricedGroup[] = [];
    for (const g of groups) {
      if (g.type === 'SERVICE') {
        const svc = serviceMap.get(g.serviceId)!;
        let unitPrice = Number(svc.basePrice);
        if (dto.city) {
          if (!cityPriceCache.has(g.serviceId)) {
            cityPriceCache.set(g.serviceId, await this.cities.getServicePrice(dto.city, g.serviceId));
          }
          const override = cityPriceCache.get(g.serviceId);
          if (override !== null && override !== undefined) unitPrice = override;
        }
        const groupAmount = unitPrice * g.quantity;
        commissionByService.set(g.serviceId, await resolveCommission(this.prisma, {
          serviceId: svc.id, categoryId: svc.categoryId, cityId: orderCityId, amount: groupAmount,
        }));
        pricedGroups.push({ type: 'SERVICE', amount: groupAmount, serviceId: g.serviceId, quantity: g.quantity });
      } else {
        let amount = 0;
        const items = g.items.map((it) => {
          const p = productMap.get(it.productId)!;
          const totalPrice = Number(p.price) * it.quantity;
          amount += totalPrice;
          return { productId: it.productId, quantity: it.quantity, unitPrice: Number(p.price), totalPrice };
        });
        pricedGroups.push({ type: 'PRODUCT', amount, vendorId: g.vendorId, items });
      }
    }

    // Resolve address — same addressId / inline-address pattern as CreateOrderDto
    let resolvedAddressId = dto.addressId;
    let resolvedAddress: Awaited<ReturnType<typeof this.prisma.address.findUnique>> = null;
    if (!resolvedAddressId && dto.inlineAddress) {
      resolvedAddress = await this.prisma.address.create({
        data: {
          userId: customerId,
          label: dto.inlineAddress.label || 'Delivery Address',
          fullAddress: dto.inlineAddress.fullAddress,
          city: dto.inlineAddress.city || '',
          state: dto.inlineAddress.state || '',
          pincode: dto.inlineAddress.pincode || '',
          latitude: dto.inlineAddress.latitude || 0,
          longitude: dto.inlineAddress.longitude || 0,
        },
      });
      resolvedAddressId = resolvedAddress.id;
    } else if (resolvedAddressId) {
      // An existing saved address was selected — snapshot it as it is *right now*.
      // Later edits to this Address row must not retroactively change this order.
      resolvedAddress = await this.prisma.address.findUnique({ where: { id: resolvedAddressId } });
    }

    // Master-level totals — computed once against the combined subtotal, exactly like
    // OrdersService.create() does for a single order. No promotion-eligibility logic
    // beyond what CouponsService.validate() already does (unchanged, out of scope here).
    const grossServiceAmount = pricedGroups.filter((g) => g.type === 'SERVICE').reduce((s, g) => s + g.amount, 0);
    const grossProductAmount = pricedGroups.filter((g) => g.type === 'PRODUCT').reduce((s, g) => s + g.amount, 0);
    const subtotal = grossServiceAmount + grossProductAmount;
    if (subtotal <= 0) throw new BadRequestException('Order total must be greater than zero');

    const membershipPct = await this.memberships.getActiveDiscount(customerId);
    const membershipDiscount = Math.round(((subtotal * membershipPct) / 100) * 100) / 100;

    let couponDiscount = 0;
    let couponId: string | undefined;
    if (dto.couponCode) {
      const v = await this.coupons.validate(dto.couponCode, customerId, subtotal - membershipDiscount);
      if (!v.valid) throw new BadRequestException(v.reason);
      couponDiscount = v.discountAmount || 0;
      couponId = v.coupon?.id;
    }

    const discountedSubtotal = subtotal - membershipDiscount - couponDiscount;
    const gstAmount = Math.round(discountedSubtotal * 0.18 * 100) / 100;
    const walletUsed = Math.min(dto.walletAmount || 0, discountedSubtotal + gstAmount);
    const totalAmount = Math.max(0, discountedSubtotal + gstAmount - walletUsed);

    // Checked up front, before any rows are created — the actual debit happens later
    // (immediately below for COD, or in confirmPayment() for ONLINE) so an abandoned or
    // failed online payment never takes the customer's wallet money for an order that
    // never actually got confirmed.
    if (walletUsed > 0) {
      const walletUser = await this.prisma.user.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
      if (!walletUser || Number(walletUser.walletBalance) < walletUsed) throw new BadRequestException('Insufficient wallet balance');
    }

    // Cash payment is allowed for any mix of products and services — "Cash on Delivery"
    // for product groups, "Cash on Service" for service groups (technician collects after
    // the job, same as COD collects at the door); both just mean "don't charge upfront
    // online," so one flag covers both. A coupon-applied order is forced to ONLINE by the
    // frontend (nothing to enforce server-side beyond what's already validated above).
    const paymentMethod = opts.paymentMethod || 'ONLINE';
    const confirmUpfront = paymentMethod === 'COD';

    // Service-level payment restriction (admin-configurable, Service.paymentMode) — if
    // any service in this cart is Online-only, the whole checkout (one payment for the
    // cart) can't go COD. Same rule OrdersService.switchToCod()/GuestBookingService.book()
    // enforce, so a mixed cart can never quietly bypass it via the Master Order path.
    if (paymentMethod === 'COD') {
      const restrictedService = services.find((s) => s.paymentMode === 'ONLINE_ONLY');
      if (restrictedService) {
        throw new BadRequestException(
          `${restrictedService.name} requires online payment — Cash on Delivery isn't available for this order.`,
        );
      }
    }

    // Allocate master-level discount/GST/wallet back down to each child group,
    // proportionally, exact-sum-preserving — so every child Order's own pricing fields
    // (read directly by the existing complete()/invoice-generation code) stay consistent.
    const groupAmounts = pricedGroups.map((g) => g.amount);
    const groupDiscounts = allocateAcrossGroups(groupAmounts, subtotal, membershipDiscount + couponDiscount);
    const groupGst = allocateAcrossGroups(groupAmounts, subtotal, gstAmount);
    const groupWallet = allocateAcrossGroups(groupAmounts, subtotal, walletUsed);

    const masterOrderNumber = await this.generateMasterOrderNumber();
    const isGuest = !opts.customerId;

    const { masterOrder, childOrders } = await this.prisma.$transaction(async (tx) => {
      const masterOrder = await tx.masterOrder.create({
        data: {
          masterOrderNumber, customerId, addressId: resolvedAddressId,
          ...addressSnapshotFields(resolvedAddress),
          channel: dto.channel || BookingChannel.WEBSITE,
          status: confirmUpfront ? MasterOrderStatus.CONFIRMED : MasterOrderStatus.PENDING_PAYMENT,
          paymentStatus: PaymentStatus.PENDING,
          grossServiceAmount, grossProductAmount, subtotal,
          couponCode: dto.couponCode, couponDiscount, membershipDiscount,
          walletUsed, gstAmount, totalAmount,
          guestName: isGuest ? opts.guestName : undefined,
          guestPhone: isGuest ? opts.guestPhone : undefined,
          guestEmail: isGuest ? opts.guestEmail : undefined,
          customerGstin: dto.gstin || undefined,
          customerGstName: dto.gstBusinessName || undefined,
        },
      });

      const childOrders: any[] = [];
      for (let i = 0; i < pricedGroups.length; i++) {
        const g = pricedGroups[i];
        const childDiscount = groupDiscounts[i];
        const childGst = groupGst[i];
        const childWallet = groupWallet[i];
        const serviceAmount = g.type === 'SERVICE' ? g.amount : 0;
        const productsAmount = g.type === 'PRODUCT' ? g.amount : 0;
        const childTotal = Math.max(0, g.amount - childDiscount + childGst - childWallet);
        const childCommission = (g.type === 'SERVICE' && g.serviceId)
          ? commissionByService.get(g.serviceId) || { commissionAmount: 0, ruleId: null, ruleLabel: 'No rule — ₹0' }
          : { commissionAmount: 0, ruleId: null, ruleLabel: 'Product line — no commission' };
        const remontCommission = childCommission.commissionAmount;
        const vendorPayout = serviceAmount - remontCommission;
        const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const startOtp = g.type === 'SERVICE' ? Math.floor(1000 + Math.random() * 9000).toString() : undefined;
        const endOtp = g.type === 'SERVICE' ? Math.floor(1000 + Math.random() * 9000).toString() : undefined;

        const childOrder = await tx.order.create({
          data: {
            orderNumber, masterOrderId: masterOrder.id, customerId,
            type: g.type === 'SERVICE' ? OrderType.SERVICE : OrderType.PRODUCT,
            channel: dto.channel || BookingChannel.WEBSITE,
            serviceId: g.type === 'SERVICE' ? g.serviceId : undefined,
            addressId: resolvedAddressId,
            ...addressSnapshotFields(resolvedAddress),
            slotStart: dto.slotStart ? new Date(dto.slotStart) : null,
            slotEnd: dto.slotEnd ? new Date(dto.slotEnd) : null,
            startOtp, endOtp,
            status: confirmUpfront ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT,
            paymentStatus: PaymentStatus.PENDING,
            serviceAmount, productsAmount, subtotal: g.amount,
            couponDiscount: childDiscount, gstAmount: childGst, walletUsed: childWallet,
            totalAmount: childTotal, remontCommission, vendorPayout,
            commissionRuleId: childCommission.ruleId, commissionRuleLabel: childCommission.ruleLabel,
            guestName: isGuest ? opts.guestName : undefined,
            guestPhone: isGuest ? opts.guestPhone : undefined,
            items: g.type === 'PRODUCT'
              ? { create: g.items!.map((it) => ({ productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice, totalPrice: it.totalPrice, vendorId: g.vendorId })) }
              : undefined,
          },
        });
        await tx.orderTimeline.create({ data: { orderId: childOrder.id, status: childOrder.status } });
        if (g.type === 'SERVICE') {
          // Each service child gets its own independent OTP pair (see startOtp/endOtp
          // above, generated fresh per loop iteration) — logged individually here so a
          // master order with N different service partners has N separate audit trails.
          await writeOtpLog(tx, { orderId: childOrder.id, otpType: 'START', otp: startOtp!, action: 'GENERATED', requestedByRole: 'SYSTEM' });
          await writeOtpLog(tx, { orderId: childOrder.id, otpType: 'END', otp: endOtp!, action: 'GENERATED', requestedByRole: 'SYSTEM' });
        }
        childOrders.push(childOrder);
      }

      return { masterOrder, childOrders };
    });

    if (couponId) await this.coupons.recordUsage(couponId, customerId, masterOrder.id, couponDiscount);

    // COD/Cash confirms immediately, so the wallet portion (if any) is real money owed
    // right now — debit it now. For ONLINE, the wallet debit happens in confirmPayment()
    // instead, once the online portion has actually been paid.
    if (confirmUpfront && walletUsed > 0) {
      await this.debitWalletForOrder(customerId, walletUsed, masterOrder.id, masterOrder.masterOrderNumber);
    }

    if (confirmUpfront) {
      for (const child of childOrders) {
        if (child.serviceId) this.routing.route(child.id).catch((e) => this.logger.error(`Routing failed: ${e.message}`));
      }
      return { masterOrderNumber: masterOrder.masterOrderNumber, masterOrderId: masterOrder.id, totalAmount, paymentMethod: 'COD', isCOD: true };
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    const payOrder: any = await this.payments.initiatePayment(customerId, totalAmount, masterOrder.id, frontendUrl);

    if (payOrder.gateway === 'PHONEPE') {
      return {
        masterOrderNumber: masterOrder.masterOrderNumber, masterOrderId: masterOrder.id, totalAmount,
        paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
        gateway: 'PHONEPE', redirectUrl: payOrder.redirectUrl, txId: payOrder.txId,
      };
    }
    return {
      masterOrderNumber: masterOrder.masterOrderNumber, masterOrderId: masterOrder.id, totalAmount,
      paymentMethod: 'ONLINE', isCOD: false, requiresPayment: true,
      gateway: 'RAZORPAY', gatewayOrderId: payOrder.gatewayOrderId, razorpayKeyId: payOrder.keyId, txId: payOrder.txId,
    };
  }

  // Mirrors OrdersService.confirmPayment()'s exact HMAC-reverify + idempotency pattern,
  // then cascades PAID/CONFIRMED down to every child order and dispatches each service
  // child exactly as a standalone order would be dispatched today.
  async confirmPayment(masterOrderId: string, paymentId: string, gatewayOrderId?: string, signature?: string) {
    if (gatewayOrderId && signature) {
      if (!process.env.RAZORPAY_KEY_SECRET) throw new BadRequestException('Payment gateway not configured');
      const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${gatewayOrderId}|${paymentId}`).digest('hex');
      if (expected !== signature) throw new BadRequestException('Invalid payment signature');
      const linkedTx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId, orderId: masterOrderId } });
      if (!linkedTx) throw new BadRequestException('Payment does not belong to this order');
    } else {
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { orderId: masterOrderId, status: 'PAID' } });
      if (!tx) throw new BadRequestException('Payment not verified. Contact support.');
    }

    const existing = await this.prisma.masterOrder.findUnique({ where: { id: masterOrderId }, include: { childOrders: true } });
    if (!existing) throw new NotFoundException('Master order not found');
    if (existing.paymentStatus === 'PAID') return existing; // idempotent
    if (existing.status !== MasterOrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Order cannot be confirmed in its current state');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.masterOrder.update({ where: { id: masterOrderId }, data: { paymentId, paymentStatus: 'PAID', status: MasterOrderStatus.CONFIRMED } });
      for (const child of existing.childOrders) {
        await tx.order.update({ where: { id: child.id }, data: { paymentId, paymentStatus: 'PAID', status: OrderStatus.CONFIRMED } });
        await tx.orderTimeline.create({ data: { orderId: child.id, status: OrderStatus.CONFIRMED } });
      }
    });

    // The wallet portion (if any) was only reserved-and-checked at checkout time, not
    // debited — only take the money now that the online payment has actually cleared.
    // Guarded by the paymentStatus==='PAID' idempotency check above, same as the rest of
    // this method.
    if (Number(existing.walletUsed) > 0) {
      await this.debitWalletForOrder(existing.customerId, Number(existing.walletUsed), existing.id, existing.masterOrderNumber);
    }

    for (const child of existing.childOrders) {
      if (child.serviceId) this.routing.route(child.id).catch((e) => this.logger.error(`Routing failed: ${e.message}`));
    }

    this.notifyPaymentSuccess(existing).catch(() => {});
    return this.prisma.masterOrder.findUnique({ where: { id: masterOrderId }, include: { childOrders: true } });
  }

  private async notifyPaymentSuccess(mo: { id: string; customerId: string; guestPhone: string | null; masterOrderNumber: string; totalAmount: any }) {
    const phone = mo.guestPhone || (await this.prisma.user.findUnique({ where: { id: mo.customerId }, select: { phone: true } }))?.phone;
    if (!phone) return;
    await this.paymentNotify.paymentSuccess(mo.customerId, phone, mo.masterOrderNumber, Number(mo.totalAmount), mo.id);
  }

  async findMine(customerId: string) {
    const orders = await this.prisma.masterOrder.findMany({
      where: { customerId },
      include: {
        address: true,
        childOrders: { include: { service: true, items: { include: { product: true } }, delivery: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((o) => ({ ...o, progress: deriveMasterProgress(o.childOrders.map((c) => c.status)) }));
  }

  async findById(id: string, requesterId: string, requesterRole: UserRole) {
    const mo = await this.detailQuery(id);
    if (!mo) throw new NotFoundException('Master order not found');
    const isOwner = mo.customerId === requesterId;
    const isStaff = requesterRole === UserRole.ADMIN || requesterRole === UserRole.SUPER_ADMIN;
    if (!isOwner && !isStaff) throw new ForbiddenException();
    return { ...mo, progress: deriveMasterProgress(mo.childOrders.map((c) => c.status)) };
  }

  async trackByNumber(masterOrderNumber: string, phone: string) {
    const mo = await this.prisma.masterOrder.findUnique({
      where: { masterOrderNumber },
      include: {
        address: true,
        customer: { select: { phone: true } },
        childOrders: {
          include: { service: true, vendor: { include: { user: { select: { name: true, phone: true } } } }, items: { include: { product: true } } },
        },
      },
    });
    if (!mo) throw new NotFoundException('Order not found');
    const ownerPhone = mo.guestPhone || mo.customer?.phone;
    if (ownerPhone && ownerPhone !== phone) throw new ForbiddenException('Access denied');
    return { ...mo, progress: deriveMasterProgress(mo.childOrders.map((c) => c.status)) };
  }

  async adminList(opts: { status?: string; q?: string; limit?: number; offset?: number }) {
    const orders = await this.prisma.masterOrder.findMany({
      where: {
        ...(opts.status ? { status: opts.status as any } : {}),
        ...(opts.q ? {
          OR: [
            { masterOrderNumber: { contains: opts.q, mode: 'insensitive' as const } },
            { customer: { name: { contains: opts.q, mode: 'insensitive' as const } } },
            { customer: { phone: { contains: opts.q } } },
          ],
        } : {}),
      },
      include: {
        customer: { select: { name: true, phone: true } },
        childOrders: { select: { id: true, orderNumber: true, type: true, status: true, totalAmount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
    });
    return orders.map((o) => ({ ...o, progress: deriveMasterProgress(o.childOrders.map((c) => c.status)) }));
  }

  async adminGetById(id: string) {
    const mo = await this.detailQuery(id);
    if (!mo) throw new NotFoundException('Master order not found');
    return { ...mo, progress: deriveMasterProgress(mo.childOrders.map((c) => c.status)) };
  }

  private detailQuery(id: string) {
    return this.prisma.masterOrder.findUnique({
      where: { id },
      include: {
        address: true,
        customer: { select: { name: true, phone: true } },
        childOrders: {
          include: {
            service: true, vendor: { include: { user: { select: { name: true, phone: true } } } },
            items: { include: { product: { include: { vendor: { select: { businessName: true } } } } } },
            invoice: true, delivery: true,
            timeline: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
  }
}

// ─── Controllers ───

@ApiTags('Master Orders')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('master-orders')
export class MasterOrdersController {
  constructor(private masterOrders: MasterOrdersService) {}

  @Post()
  checkout(@CurrentUser() u: JwtPayload, @Body() dto: CreateMasterOrderDto) {
    return this.masterOrders.checkout(dto, { customerId: u.sub });
  }

  @Post(':id/confirm-payment')
  confirmPayment(@Param('id') id: string, @Body() b: { paymentId: string; gatewayOrderId?: string; signature?: string }) {
    return this.masterOrders.confirmPayment(id, b.paymentId, b.gatewayOrderId, b.signature);
  }

  @Get('mine')
  mine(@CurrentUser() u: JwtPayload) { return this.masterOrders.findMine(u.sub); }

  @Get(':id')
  detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.masterOrders.findById(id, u.sub, u.role);
  }
}

@ApiTags('Master Orders')
@Controller('master-orders/public')
export class PublicMasterOrderController {
  constructor(private masterOrders: MasterOrdersService) {}

  @Public() @Post('checkout')
  checkout(@Body() dto: PublicMasterCheckoutDto) {
    const items = dto.items;
    const checkoutDto: CreateMasterOrderDto = {
      items, channel: dto.channel, couponCode: dto.couponCode,
      walletAmount: dto.walletAmount, gstin: dto.gstin, gstBusinessName: dto.gstBusinessName,
      slotStart: dto.slotStart, slotEnd: dto.slotEnd, city: dto.city,
      inlineAddress: {
        fullAddress: dto.fullAddress, city: dto.city, state: dto.state, pincode: dto.pincode,
        latitude: dto.latitude, longitude: dto.longitude,
      },
    };
    return this.masterOrders.checkout(checkoutDto, {
      guestName: dto.name, guestPhone: dto.phone, guestEmail: dto.email, paymentMethod: dto.paymentMethod,
    });
  }

  @Public() @Post('confirm-payment')
  confirmPayment(@Body() b: { dbOrderId: string; gatewayOrderId: string; paymentId: string; signature: string }) {
    return this.masterOrders.confirmPayment(b.dbOrderId, b.paymentId, b.gatewayOrderId, b.signature);
  }

  @Public() @Get('track/:masterOrderNumber')
  track(@Param('masterOrderNumber') num: string, @Query('phone') phone: string) {
    return this.masterOrders.trackByNumber(num, phone);
  }
}

// ─── Module ───
@Module({
  imports: [CouponsModule, MembershipsModule, CitiesModule, PaymentsModule, OrdersModule, PaymentNotificationsModule],
  // PublicMasterOrderController MUST be registered before MasterOrdersController —
  // Express/Nest matches routes in registration order, and MasterOrdersController's
  // POST /master-orders/:id/confirm-payment (a wildcard :id) would otherwise swallow
  // POST /master-orders/public/confirm-payment first (treating "public" as the :id),
  // routing public/guest requests into the JWT-guarded handler and rejecting them with
  // a 401 before they ever reach the intended public one. Found via a live end-to-end
  // Razorpay confirm-payment test, not by inspection.
  controllers: [PublicMasterOrderController, MasterOrdersController],
  providers: [MasterOrdersService],
  exports: [MasterOrdersService],
})
export class MasterOrdersModule {}
