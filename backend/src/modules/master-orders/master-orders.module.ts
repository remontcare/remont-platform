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
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, addressSnapshotFields, writeOtpLog, writeOrderTimeline, resolveCommission, resolveProductFee, resolveProductGstLine, buildTaxRateResolver, PLATFORM_FEE_DEFAULT_RATE, isValidIndiaCoords } from '../../common';
import { CouponsService, CouponsModule } from '../coupons/coupons.module';
import { MembershipsService, MembershipsModule } from '../memberships/memberships.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { DispatchService, RoutingService, OrdersModule } from '../orders/orders.module';
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';
import { ShipmentService, LogisticsService, LogisticsModule } from '../logistics/logistics.module';

// ─── Pure functions (no DB) — unit-tested directly, see master-orders.split.spec.ts ───

export type SplitCartItem =
  | { type: 'SERVICE'; serviceId: string; categoryId: string; quantity: number }
  | { type: 'PRODUCT'; productId: string; vendorId: string | null; quantity: number };

export type SplitGroup =
  | { type: 'SERVICE'; categoryId: string; services: { serviceId: string; quantity: number }[] }
  | { type: 'PRODUCT'; vendorId: string | null; items: { productId: string; quantity: number }[] };

// Smart Order Grouping: Same Customer + Same Address + Same Service Category + Same
// Checkout = ONE Order. This function only owns the last axis (category/seller grouping);
// "same customer/address/checkout" falls out for free because checkout() below runs once
// per HTTP request against one resolved address for the whole cart — a second checkout
// (even seconds later, even the identical cart) always produces a new MasterOrder and thus
// new, separate child Orders, so nothing here needs to re-check those three.
//
// Services are grouped by distinct Service.categoryId — every service in the same category
// (e.g. Electrical: Fan Installation + Switch Board Installation) collapses into one child
// Order carrying multiple OrderServiceItem rows (see master-orders.module.ts's
// checkout()/schema.prisma's OrderServiceItem), one per distinct category becomes one
// Order. Products are grouped by distinct Product.vendorId — one child order per seller.
export function groupCartForSplit(items: SplitCartItem[]): SplitGroup[] {
  const servicesByCategory = new Map<string, Map<string, number>>();
  const productsByVendor = new Map<string, Map<string, number>>();

  for (const item of items) {
    if (item.type === 'SERVICE') {
      if (!servicesByCategory.has(item.categoryId)) servicesByCategory.set(item.categoryId, new Map());
      const perCategory = servicesByCategory.get(item.categoryId)!;
      perCategory.set(item.serviceId, (perCategory.get(item.serviceId) || 0) + (item.quantity || 1));
    } else {
      const vendorKey = item.vendorId || '__unassigned__';
      if (!productsByVendor.has(vendorKey)) productsByVendor.set(vendorKey, new Map());
      const perVendor = productsByVendor.get(vendorKey)!;
      perVendor.set(item.productId, (perVendor.get(item.productId) || 0) + (item.quantity || 1));
    }
  }

  const groups: SplitGroup[] = [];
  for (const [categoryId, serviceQty] of servicesByCategory) {
    groups.push({
      type: 'SERVICE',
      categoryId,
      services: Array.from(serviceQty, ([serviceId, quantity]) => ({ serviceId, quantity })),
    });
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

// Payment Mode business rules — Service.paymentMode is ANY (Online + COD), ONLINE_ONLY, or
// COD_ONLY. A checkout can mix services from several categories (Smart Order Grouping still
// splits them into separate child Orders), but the customer picks ONE payment method for the
// whole cart/checkout — so the cart-wide answer is the intersection of what every individual
// service allows: Online is blocked if ANY item is COD_ONLY; COD is blocked if ANY item is
// ONLINE_ONLY. Pure function — no DB — so both directions are trivially unit-testable.
export function resolveCheckoutPaymentOptions(
  services: { name: string; paymentMode: string }[],
): { online: boolean; cod: boolean; onlineBlockedBy: string | null; codBlockedBy: string | null } {
  const codOnly = services.find((s) => s.paymentMode === 'COD_ONLY') || null;
  const onlineOnly = services.find((s) => s.paymentMode === 'ONLINE_ONLY') || null;
  return {
    online: !codOnly,
    cod: !onlineOnly,
    onlineBlockedBy: codOnly?.name ?? null,
    codBlockedBy: onlineOnly?.name ?? null,
  };
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
  categoryId?: string; // SERVICE groups
  vendorId?: string | null; // PRODUCT groups
  items: {
    serviceId?: string; productId?: string; quantity: number; unitPrice: number; totalPrice: number;
    // Phase 8 — per-item GST snapshot for PRODUCT items, resolved via resolveProductGstLine().
    gstInclusive?: boolean; gstRatePercent?: number; taxableValue?: number; gstAmount?: number;
  }[];
  // Phase 7 — resolved+summed marketplace fees for a PRODUCT group, snapshotted onto the
  // child Order's productFeeBreakdown/remontCommission at creation (see checkout() below).
  // The `delivery` component is added later, at settlement (ProductLedgerService).
  productFees?: {
    commission: { amount: number; ruleId: string | null; ruleLabel: string };
    marketing: { amount: number; ruleId: string | null; ruleLabel: string };
    gateway: { amount: number; ruleId: string | null; ruleLabel: string };
    gstOnFees: { amount: number; ratePercent: number };
  };
  // Phase 8 — PRODUCT group GST rollups. productGstOnTop is added to reach the customer's
  // charged total (only EXCLUSIVE lines contribute — an INCLUSIVE line's tax is already
  // embedded in its own price, never added again). productsTaxableAmount is the ex-GST
  // base across every line regardless of treatment — this is what settlement's GROSS_SALE
  // and reporting/breakdown use, per the resolved "seller doesn't earn commission on GST"
  // decision.
  productsTaxableAmount?: number;
  productGstOnTop?: number;
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
    private shipments: ShipmentService,
    private logistics: LogisticsService,
  ) {}

  // Phase 5 — opens the seller-processing window right after payment confirms, instead of
  // creating a Shipment immediately (that now only happens once the seller marks the order
  // ready-for-pickup — see ProductVendorsService.markReadyForPickup(), vendors.module.ts).
  // Best-effort, called from a .catch()-guarded call site — never allowed to fail checkout.
  private async openSellerFulfillmentWindow(orderId: string): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId },
      data: { productFulfillmentStage: 'AWAITING_SELLER', productFulfillmentAt: new Date() },
    });
    await writeOrderTimeline(this.prisma, { orderId, status: 'AWAITING_SELLER' });
  }

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
        splitItems.push({ type: 'SERVICE', serviceId: svc.id, categoryId: svc.categoryId, quantity: item.quantity || 1 });
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
    // Phase 8 — lazily resolved at most once per checkout() call (only if the cart actually
    // has a PRODUCT group), reused for every PRODUCT item below — exactly the same resolver
    // invoices.module.ts's Type 3 branch already uses. Lazy so a pure-SERVICE cart never
    // issues this query at all.
    let prodTax: Awaited<ReturnType<typeof buildTaxRateResolver>> | null = null;
    const getProdTax = async () => (prodTax ??= await buildTaxRateResolver(this.prisma, 'PRODUCT'));
    const pricedGroups: PricedGroup[] = [];
    for (const g of groups) {
      if (g.type === 'SERVICE') {
        let amount = 0;
        const items: PricedGroup['items'] = [];
        for (const line of g.services) {
          const svc = serviceMap.get(line.serviceId)!;
          let unitPrice = Number(svc.basePrice);
          if (dto.city) {
            if (!cityPriceCache.has(line.serviceId)) {
              cityPriceCache.set(line.serviceId, await this.cities.getServicePrice(dto.city, line.serviceId));
            }
            const override = cityPriceCache.get(line.serviceId);
            if (override !== null && override !== undefined) unitPrice = override;
          }
          const totalPrice = unitPrice * line.quantity;
          amount += totalPrice;
          commissionByService.set(line.serviceId, await resolveCommission(this.prisma, {
            serviceId: svc.id, categoryId: svc.categoryId, cityId: orderCityId, amount: totalPrice,
          }));
          items.push({ serviceId: line.serviceId, quantity: line.quantity, unitPrice, totalPrice });
        }
        pricedGroups.push({ type: 'SERVICE', amount, categoryId: g.categoryId, items });
      } else {
        let amount = 0;
        let productsTaxableAmount = 0, productGstOnTop = 0;
        const items: PricedGroup['items'] = [];
        for (const it of g.items) {
          const p = productMap.get(it.productId)!;
          const totalPrice = Number(p.price) * it.quantity;
          amount += totalPrice;
          // Phase 8 — resolve this line's real GST treatment instead of the old flat-18%-
          // on-the-whole-cart approach. An INCLUSIVE line's tax is only ever a split of the
          // price shown (never added again below); an EXCLUSIVE line's tax genuinely adds
          // to what the customer is charged.
          const gstLine = await resolveProductGstLine(await getProdTax(), p, totalPrice);
          productsTaxableAmount += gstLine.taxableValue;
          if (!gstLine.inclusive) productGstOnTop += gstLine.gstAmount;
          items.push({
            productId: it.productId, quantity: it.quantity, unitPrice: Number(p.price), totalPrice,
            gstInclusive: gstLine.inclusive, gstRatePercent: gstLine.ratePercent,
            taxableValue: gstLine.taxableValue, gstAmount: gstLine.gstAmount,
          });
        }

        // Phase 7 — resolve commission/marketing/gateway per line, summed across the group
        // (one child Order per vendor, so this is the order-level total), same await-in-loop
        // spirit as the SERVICE branch's commissionByService above. Falls back to 0 whenever
        // no ProductFeeRule is configured — never a hardcoded percentage.
        let commissionTotal = 0, marketingTotal = 0, gatewayTotal = 0;
        let commissionRuleId: string | null = null, commissionRuleLabel = 'No rule — ₹0';
        let marketingRuleId: string | null = null, marketingRuleLabel = 'No rule — ₹0';
        let gatewayRuleId: string | null = null, gatewayRuleLabel = 'No rule — ₹0';
        for (const it of items) {
          const p = productMap.get(it.productId!)!;
          const [commission, marketing, gateway] = await Promise.all([
            resolveProductFee(this.prisma, { feeType: 'COMMISSION', productId: p.id, productCategoryId: p.categoryId, amount: it.totalPrice }),
            resolveProductFee(this.prisma, { feeType: 'MARKETING', productId: p.id, productCategoryId: p.categoryId, amount: it.totalPrice }),
            resolveProductFee(this.prisma, { feeType: 'GATEWAY', productId: p.id, productCategoryId: p.categoryId, amount: it.totalPrice }),
          ]);
          commissionTotal += commission.feeAmount; commissionRuleId = commission.ruleId; commissionRuleLabel = commission.ruleLabel;
          marketingTotal += marketing.feeAmount; marketingRuleId = marketing.ruleId; marketingRuleLabel = marketing.ruleLabel;
          gatewayTotal += gateway.feeAmount; gatewayRuleId = gateway.ruleId; gatewayRuleLabel = gateway.ruleLabel;
        }
        // GST on Remont's own fees (commission + marketing + gateway) — reuses the exact
        // same PLATFORM_FEE tax scope invoices.module.ts already uses for "Marketplace
        // Commission" GST, so the two never disagree.
        const feeTax = await buildTaxRateResolver(this.prisma, 'PLATFORM_FEE', PLATFORM_FEE_DEFAULT_RATE);
        const gstRate = feeTax.rateFor(null, null);
        const totalFees = commissionTotal + marketingTotal + gatewayTotal;
        const gstOnFeesAmount = Math.round(((totalFees * gstRate) / 100) * 100) / 100;

        pricedGroups.push({
          type: 'PRODUCT', amount, vendorId: g.vendorId, items,
          productsTaxableAmount, productGstOnTop,
          productFees: {
            commission: { amount: commissionTotal, ruleId: commissionRuleId, ruleLabel: commissionRuleLabel },
            marketing: { amount: marketingTotal, ruleId: marketingRuleId, ruleLabel: marketingRuleLabel },
            gateway: { amount: gatewayTotal, ruleId: gatewayRuleId, ruleLabel: gatewayRuleLabel },
            gstOnFees: { amount: gstOnFeesAmount, ratePercent: gstRate },
          },
        });
      }
    }

    // Resolve address — same addressId / inline-address pattern as CreateOrderDto
    let resolvedAddressId = dto.addressId;
    let resolvedAddress: Awaited<ReturnType<typeof this.prisma.address.findUnique>> = null;
    if (!resolvedAddressId && dto.inlineAddress) {
      // Bounds-check client-supplied coords before trusting them for dispatch distance math
      // — same guard publicProductCheckout() already applies; a garbage/out-of-range value
      // (or one of Null Island's (0,0)) is stored as "no coords" rather than corrupting
      // nearest-vendor matching for this order.
      const hasValidCoords = isValidIndiaCoords(dto.inlineAddress.latitude, dto.inlineAddress.longitude);
      resolvedAddress = await this.prisma.address.create({
        data: {
          userId: customerId,
          label: dto.inlineAddress.label || 'Delivery Address',
          fullAddress: dto.inlineAddress.fullAddress,
          city: dto.inlineAddress.city || '',
          state: dto.inlineAddress.state || '',
          pincode: dto.inlineAddress.pincode || '',
          latitude: hasValidCoords ? dto.inlineAddress.latitude! : 0,
          longitude: hasValidCoords ? dto.inlineAddress.longitude! : 0,
        },
      });
      resolvedAddressId = resolvedAddress.id;
    } else if (resolvedAddressId) {
      // An existing saved address was selected — snapshot it as it is *right now*.
      // Later edits to this Address row must not retroactively change this order.
      resolvedAddress = await this.prisma.address.findUnique({ where: { id: resolvedAddressId } });
    }

    // Phase 4 — delivery charge per PRODUCT group (backend/src/modules/logistics). Unlike
    // GST/discount/wallet below, this is naturally a per-group number already (each PRODUCT
    // group already has its own vendor/product) — never pooled-then-split via
    // allocateAcrossGroups(), each child Order just gets its own group's own charge directly.
    // Needs resolvedAddressId, so this must run after address resolution above. A flat line
    // item, deliberately not itself subject to the GST computed below (a stated
    // simplification, not a tax-correctness claim).
    const groupDelivery = await Promise.all(pricedGroups.map(async (g) => {
      if (g.type !== 'PRODUCT' || !g.items.length) return { tier: null as any, charge: 0 };
      const eligibility = await this.logistics.checkEligibility({ productId: g.items[0].productId!, addressId: resolvedAddressId });
      return { tier: eligibility.tier, charge: eligibility.charge };
    }));
    const deliveryCharge = groupDelivery.reduce((s, d) => s + d.charge, 0);

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
    // Phase 8 — SERVICE-side GST stays flat 18%, applied to the service's own discounted
    // share (unchanged methodology, just no longer blended with products). PRODUCT-side
    // GST is the sum of each group's already-resolved real per-item GST (§ pricing loop
    // above) — an INCLUSIVE line's tax is embedded in its price and never added here; only
    // EXCLUSIVE lines contribute to productGstOnTop.
    const serviceDiscountShare = grossServiceAmount > 0
      ? allocateAcrossGroups([grossServiceAmount], subtotal, membershipDiscount + couponDiscount)[0]
      : 0;
    const discountedServiceAmount = Math.max(0, grossServiceAmount - serviceDiscountShare);
    const serviceGstAmount = Math.round(discountedServiceAmount * 0.18 * 100) / 100;
    const productGstOnTop = pricedGroups.filter((g) => g.type === 'PRODUCT').reduce((s, g) => s + (g.productGstOnTop || 0), 0);
    const gstAmount = Math.round((serviceGstAmount + productGstOnTop) * 100) / 100;
    const walletUsed = Math.min(dto.walletAmount || 0, discountedSubtotal + gstAmount + deliveryCharge);
    const totalAmount = Math.max(0, discountedSubtotal + gstAmount + deliveryCharge - walletUsed);

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

    // Service-level payment restriction (admin-configurable, Service.paymentMode) — the
    // whole checkout is one payment for the cart, so every service in it must actually
    // allow the chosen method. Same rule OrdersService.switchToCod()/retryPayment() and
    // GuestBookingService.book() enforce, so a mixed cart can never quietly bypass it via
    // the Master Order path.
    const paymentOptions = resolveCheckoutPaymentOptions(services);
    if (paymentMethod === 'COD' && !paymentOptions.cod) {
      throw new BadRequestException(
        `${paymentOptions.codBlockedBy} requires online payment — Cash on Delivery isn't available for this order.`,
      );
    }
    if (paymentMethod === 'ONLINE' && !paymentOptions.online) {
      throw new BadRequestException(
        `${paymentOptions.onlineBlockedBy} is Cash on Delivery only — online payment isn't available for this order.`,
      );
    }

    // Allocate master-level discount/GST/wallet back down to each child group,
    // proportionally, exact-sum-preserving — so every child Order's own pricing fields
    // (read directly by the existing complete()/invoice-generation code) stay consistent.
    const groupAmounts = pricedGroups.map((g) => g.amount);
    const groupDiscounts = allocateAcrossGroups(groupAmounts, subtotal, membershipDiscount + couponDiscount);
    // Phase 8 — GST is no longer one blended pool allocated by amount-share across every
    // group regardless of type: a PRODUCT group already knows its own exact GST
    // (productGstOnTop, resolved per-item above) and uses that directly; only the SERVICE-
    // side flat-18% pool still needs pro-rata splitting, and only among SERVICE groups
    // (denominator = grossServiceAmount, not the combined subtotal — isolated now that
    // products are no longer part of this pool).
    const serviceGroupIndices = pricedGroups.map((_, i) => i).filter((i) => pricedGroups[i].type === 'SERVICE');
    const serviceGstShares = allocateAcrossGroups(serviceGroupIndices.map((i) => pricedGroups[i].amount), grossServiceAmount, serviceGstAmount);
    const groupGst = pricedGroups.map((g, i) => {
      if (g.type === 'PRODUCT') return g.productGstOnTop || 0;
      return serviceGstShares[serviceGroupIndices.indexOf(i)] || 0;
    });
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
          walletUsed, gstAmount, deliveryCharge, totalAmount,
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
        const childDelivery = groupDelivery[i];
        const serviceAmount = g.type === 'SERVICE' ? g.amount : 0;
        const productsAmount = g.type === 'PRODUCT' ? g.amount : 0;
        const childTotal = Math.max(0, g.amount - childDiscount + childGst + childDelivery.charge - childWallet);

        // A SERVICE group can now hold several services from the same category (Smart
        // Order Grouping) — sum each line's own commission for the order-level total, and
        // key the order's single serviceId/commissionRule* display fields off the first
        // line (matches every existing single-service read path unchanged; the full
        // per-service breakdown lives in serviceItems below regardless of count).
        let remontCommission = 0;
        let primaryRule: { commissionAmount: number; ruleId: string | null; ruleLabel: string } = {
          commissionAmount: 0, ruleId: null, ruleLabel: 'Product line — no commission',
        };
        if (g.type === 'SERVICE') {
          for (const it of g.items) {
            const c = commissionByService.get(it.serviceId!) || { commissionAmount: 0, ruleId: null, ruleLabel: 'No rule — ₹0' };
            remontCommission += c.commissionAmount;
          }
          primaryRule = commissionByService.get(g.items[0].serviceId!) || { commissionAmount: 0, ruleId: null, ruleLabel: 'No rule — ₹0' };
        } else if (g.productFees) {
          // Phase 7 — commission reuses the existing remontCommission/commissionRuleId/
          // commissionRuleLabel columns (so invoices.module.ts's already-proven "Marketplace
          // Commission" invoice line, which reads order.remontCommission, works unmodified).
          // Marketing/gateway/GST-on-fees have no equivalent scalar columns — they live only
          // in productFeeBreakdown below, merged with `delivery` at settlement time.
          remontCommission = g.productFees.commission.amount;
          primaryRule = { commissionAmount: remontCommission, ruleId: g.productFees.commission.ruleId, ruleLabel: g.productFees.commission.ruleLabel };
        }
        // Phase 8 — PRODUCT vendorPayout is computed off the taxable base, not the gross
        // (GST-inclusive) amount — GST collected isn't seller revenue to pay commission
        // against. No-op for an Excluded/0%-rated product, since productsTaxableAmount
        // equals productsAmount bit-for-bit there.
        const vendorPayout = g.type === 'SERVICE'
          ? serviceAmount - remontCommission
          : (g.productsTaxableAmount ?? productsAmount) - remontCommission - (g.productFees?.marketing.amount || 0) - (g.productFees?.gateway.amount || 0);
        const productFeeBreakdown = g.type === 'PRODUCT' && g.productFees
          ? { commission: g.productFees.commission, marketing: g.productFees.marketing, gateway: g.productFees.gateway, gstOnFees: g.productFees.gstOnFees }
          : undefined;
        const primaryServiceId = g.type === 'SERVICE' ? g.items[0].serviceId : undefined;
        const orderNumber = `REM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const startOtp = g.type === 'SERVICE' ? Math.floor(1000 + Math.random() * 9000).toString() : undefined;
        const endOtp = g.type === 'SERVICE' ? Math.floor(1000 + Math.random() * 9000).toString() : undefined;

        const childOrder = await tx.order.create({
          data: {
            orderNumber, masterOrderId: masterOrder.id, customerId,
            type: g.type === 'SERVICE' ? OrderType.SERVICE : OrderType.PRODUCT,
            channel: dto.channel || BookingChannel.WEBSITE,
            serviceId: primaryServiceId,
            addressId: resolvedAddressId,
            ...addressSnapshotFields(resolvedAddress),
            slotStart: g.type === 'SERVICE' && dto.slotStart ? new Date(dto.slotStart) : null,
            slotEnd: g.type === 'SERVICE' && dto.slotEnd ? new Date(dto.slotEnd) : null,
            startOtp, endOtp,
            status: confirmUpfront ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT,
            paymentStatus: PaymentStatus.PENDING,
            serviceAmount, productsAmount, subtotal: g.amount,
            productsTaxableAmount: g.type === 'PRODUCT' ? g.productsTaxableAmount : undefined,
            couponDiscount: childDiscount, gstAmount: childGst, walletUsed: childWallet,
            deliveryTier: childDelivery.tier || undefined, deliveryCharge: childDelivery.charge,
            totalAmount: childTotal, remontCommission, vendorPayout,
            commissionRuleId: primaryRule.ruleId, commissionRuleLabel: primaryRule.ruleLabel,
            productFeeBreakdown: productFeeBreakdown as any,
            guestName: isGuest ? opts.guestName : undefined,
            guestPhone: isGuest ? opts.guestPhone : undefined,
            items: g.type === 'PRODUCT'
              ? { create: g.items.map((it) => ({
                  productId: it.productId!, quantity: it.quantity, unitPrice: it.unitPrice, totalPrice: it.totalPrice, vendorId: g.vendorId,
                  gstInclusive: it.gstInclusive, gstRatePercent: it.gstRatePercent, taxableValue: it.taxableValue, gstAmount: it.gstAmount,
                })) }
              : undefined,
            serviceItems: g.type === 'SERVICE'
              ? { create: g.items.map((it) => ({ serviceId: it.serviceId!, quantity: it.quantity, unitPrice: it.unitPrice, totalPrice: it.totalPrice })) }
              : undefined,
          },
        });
        await tx.orderTimeline.create({ data: { orderId: childOrder.id, status: childOrder.status } });
        if (g.type === 'SERVICE') {
          // One OTP pair per child Order (= one vendor visit), regardless of how many
          // grouped services that visit covers — logged individually here so a master
          // order with N distinct category visits has N separate audit trails.
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
        // Phase 5 — a Shipment is no longer created right after payment; the seller must
        // accept -> process -> mark ready-for-pickup first (ProductVendorsService,
        // vendors.module.ts), which is what actually calls ShipmentService.createShipmentForOrder().
        // This just opens the seller-processing window. Never allowed to fail or delay the
        // checkout response; totalAmount/the response below are computed before this and are
        // never touched by it.
        if (child.type === OrderType.PRODUCT) this.openSellerFulfillmentWindow(child.id).catch((e) => this.logger.error(`Seller fulfillment window open failed: ${e.message}`));
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
      if (child.type === OrderType.PRODUCT) this.openSellerFulfillmentWindow(child.id).catch((e) => this.logger.error(`Seller fulfillment window open failed: ${e.message}`));
    }

    this.notifyPaymentSuccess(existing).catch(() => {});
    return this.prisma.masterOrder.findUnique({ where: { id: masterOrderId }, include: { childOrders: true } });
  }

  private async notifyPaymentSuccess(mo: { id: string; customerId: string; guestPhone: string | null; masterOrderNumber: string; totalAmount: any }) {
    const phone = mo.guestPhone || (await this.prisma.user.findUnique({ where: { id: mo.customerId }, select: { phone: true } }))?.phone;
    if (!phone) return;
    await this.paymentNotify.paymentSuccess(mo.customerId, phone, mo.masterOrderNumber, Number(mo.totalAmount), mo.id);
  }

  /**
   * Re-initiates a gateway payment for an existing, still-unpaid Master Order — mirrors
   * OrdersService.retryPayment() exactly (guest-safe phone check, PAID/locked-status
   * guards, never creates a new order or child orders), just against the master total
   * instead of one child's. Only valid while the whole checkout is still awaiting its
   * first payment — once CONFIRMED (COD or already paid), this no longer applies.
   */
  async retryPayment(masterOrderId: string, phone: string) {
    const mo = await this.prisma.masterOrder.findUnique({ where: { id: masterOrderId } });
    if (!mo) throw new NotFoundException('Order not found');
    const owner = mo.guestPhone || (await this.prisma.user.findUnique({ where: { id: mo.customerId }, select: { phone: true } }))?.phone;
    if (owner && owner !== phone) throw new ForbiddenException('Phone number does not match this order');
    if (mo.paymentStatus === 'PAID') throw new BadRequestException('Order is already paid');
    if (mo.status !== MasterOrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Payment can no longer be changed for this order');
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    const payOrder: any = await this.payments.initiatePayment(mo.customerId, Number(mo.totalAmount), mo.id, frontendUrl);
    return {
      masterOrderId: mo.id, masterOrderNumber: mo.masterOrderNumber, totalAmount: mo.totalAmount,
      gateway: payOrder.gateway, gatewayOrderId: payOrder.gatewayOrderId, razorpayKeyId: payOrder.keyId,
      redirectUrl: payOrder.redirectUrl, txId: payOrder.txId,
    };
  }

  /**
   * The reverse of retryPayment(): a Master Order booked Online that never got paid can
   * switch the WHOLE checkout to Cash on Delivery instead of endlessly retrying the same
   * gateway — cascades to every child order in one transaction (mirrors confirmPayment()'s
   * cascade pattern). Blocked if ANY grouped service is ONLINE_ONLY, exactly like a fresh
   * COD checkout would be (resolveCheckoutPaymentOptions is the single source of truth for
   * both).
   */
  async switchToCod(masterOrderId: string, phone: string) {
    const existing = await this.prisma.masterOrder.findUnique({
      where: { id: masterOrderId },
      include: { childOrders: { include: { service: true } } },
    });
    if (!existing) throw new NotFoundException('Order not found');
    const owner = existing.guestPhone || (await this.prisma.user.findUnique({ where: { id: existing.customerId }, select: { phone: true } }))?.phone;
    if (owner && owner !== phone) throw new ForbiddenException('Phone number does not match this order');
    if (existing.paymentStatus === 'PAID') throw new BadRequestException('Order is already paid online');
    if (existing.status !== MasterOrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Order has already moved past payment — cannot switch to Cash on Delivery now');
    }

    const services = existing.childOrders.map((c) => c.service).filter(Boolean) as { name: string; paymentMode: string }[];
    const options = resolveCheckoutPaymentOptions(services);
    if (!options.cod) {
      throw new BadRequestException(`${options.codBlockedBy} requires online payment — Cash on Delivery isn't available for this order.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.masterOrder.update({ where: { id: masterOrderId }, data: { status: MasterOrderStatus.CONFIRMED, paymentMethod: 'COD' } });
      for (const child of existing.childOrders) {
        await tx.order.update({ where: { id: child.id }, data: { status: OrderStatus.CONFIRMED, paymentMethod: 'COD' } });
        await writeOrderTimeline(tx, { orderId: child.id, status: OrderStatus.CONFIRMED, note: 'Switched from Online to Cash on Delivery' });
      }
    });

    for (const child of existing.childOrders) {
      if (child.serviceId) this.routing.route(child.id).catch((e) => this.logger.error(`Routing failed: ${e.message}`));
    }

    return this.prisma.masterOrder.findUnique({ where: { id: masterOrderId }, include: { childOrders: true } });
  }

  async findMine(customerId: string) {
    const orders = await this.prisma.masterOrder.findMany({
      where: { customerId },
      include: {
        address: true,
        childOrders: {
          include: {
            service: true, items: { include: { product: true } },
            serviceItems: { include: { service: true } },
            delivery: true,
          },
        },
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
          include: {
            service: true, vendor: { include: { user: { select: { name: true, phone: true } } } },
            items: { include: { product: true } },
            serviceItems: { include: { service: true } },
          },
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
            serviceItems: { include: { service: true } },
            invoice: true, delivery: true,
            // Phase 5 — admin delivery/COD visibility (frontend/admin/master-orders.html).
            shipment: { include: { deliveryPartner: { select: { id: true, user: { select: { name: true, phone: true } } } } } },
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

  // Retry a failed/abandoned payment for the whole checkout — never creates a new order.
  // Phone-verified since guests have no JWT. Mirrors orders/public/:id/retry-payment.
  @Public() @Post(':id/retry-payment')
  retryPayment(@Param('id') id: string, @Body() b: { phone: string }) {
    return this.masterOrders.retryPayment(id, b.phone);
  }

  // The reverse of retry-payment: a checkout booked Online that never got paid can switch
  // the whole cart to Cash on Delivery. Mirrors orders/public/:id/switch-to-cod.
  @Public() @Post(':id/switch-to-cod')
  switchToCod(@Param('id') id: string, @Body() b: { phone: string }) {
    return this.masterOrders.switchToCod(id, b.phone);
  }

  @Public() @Get('track/:masterOrderNumber')
  track(@Param('masterOrderNumber') num: string, @Query('phone') phone: string) {
    return this.masterOrders.trackByNumber(num, phone);
  }
}

// ─── Module ───
@Module({
  imports: [CouponsModule, MembershipsModule, CitiesModule, PaymentsModule, OrdersModule, PaymentNotificationsModule, LogisticsModule],
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
