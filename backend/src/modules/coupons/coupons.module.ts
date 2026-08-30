import { Module, Injectable, Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CouponType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class CouponsService {
  constructor(private prisma: PrismaService) {}

  // userId is optional so the guest storefront checkout (identified only by phone, no
  // account/JWT yet) can preview a coupon too — per-user usage limit simply isn't checked
  // for a not-yet-resolved guest, the same way it's skipped for a brand new account.
  async validate(code: string, userId: string | undefined, orderAmount: number) {
    const coupon = await this.prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    if (!coupon) return { valid: false, reason: 'Invalid coupon code' };
    if (!coupon.isActive) return { valid: false, reason: 'Inactive' };
    const now = new Date();
    if (coupon.validFrom > now) return { valid: false, reason: 'Not yet active' };
    if (coupon.validTill < now) return { valid: false, reason: 'Expired' };
    if (coupon.totalUsageLimit && coupon.usedCount >= coupon.totalUsageLimit) {
      return { valid: false, reason: 'Limit reached' };
    }
    if (coupon.minOrderAmount && orderAmount < Number(coupon.minOrderAmount)) {
      return { valid: false, reason: `Min order ₹${coupon.minOrderAmount}` };
    }
    if (userId) {
      const userUsage = await this.prisma.couponUsage.count({ where: { couponId: coupon.id, userId } });
      if (userUsage >= coupon.perUserLimit) return { valid: false, reason: 'Already used' };
    }

    let discount = 0;
    if (coupon.type === CouponType.PERCENT) {
      discount = (orderAmount * (coupon.discountPercent || 0)) / 100;
      if (coupon.maxDiscount) discount = Math.min(discount, Number(coupon.maxDiscount));
    } else if (coupon.type === CouponType.FLAT) {
      discount = Number(coupon.discountAmount || 0);
    }
    discount = Math.min(discount, orderAmount);
    return {
      valid: true,
      discountAmount: Math.round(discount * 100) / 100,
      // fundedBy (Phase 3, C-02/C-03) — read by MasterOrdersService.checkout()/
      // OrdersService.create() to decide whether this coupon's discount is allowed to
      // reduce PRODUCT GST taxable value / seller settlement (SELLER) or must leave both
      // untouched (PLATFORM, the default — see OrderDiscountAllocation).
      coupon: { id: coupon.id, code: coupon.code, type: coupon.type, fundedBy: coupon.fundedBy },
    };
  }

  // Resolves a phone number to its existing user (if any) so a not-yet-logged-in
  // storefront guest still gets their real per-user usage limit checked once they're a
  // known customer, and a genuinely new phone just skips that check like any new user.
  async validateByPhone(code: string, phone: string | undefined, orderAmount: number) {
    let userId: string | undefined;
    if (phone) {
      const user = await this.prisma.user.findUnique({ where: { phone } });
      if (user) userId = user.id;
    }
    return this.validate(code, userId, orderAmount);
  }

  async recordUsage(couponId: string, userId: string, orderId: string, discount: number) {
    await this.prisma.$transaction([
      this.prisma.couponUsage.create({ data: { couponId, userId, orderId, discountApplied: discount } }),
      this.prisma.coupon.update({ where: { id: couponId }, data: { usedCount: { increment: 1 } } }),
    ]);
  }

  async create(data: any) {
    return this.prisma.coupon.create({ data: { ...data, code: data.code.toUpperCase() } });
  }

  async listAvailable() {
    return this.prisma.coupon.findMany({
      where: { isActive: true, validTill: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }
}

@ApiTags('Coupons')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('coupons')
export class CouponsController {
  constructor(private c: CouponsService) {}

  @Get('available') list() { return this.c.listAvailable(); }
  @Post('validate') validate(@CurrentUser() u: JwtPayload, @Body() b: { code: string; orderAmount: number }) {
    return this.c.validate(b.code, u.sub, b.orderAmount);
  }

  // Public preview used by the guest checkout modal (phone-identified, no JWT yet).
  @Public() @Post('validate-guest')
  validateGuest(@Body() b: { code: string; phone?: string; orderAmount: number }) {
    return this.c.validateByPhone(b.code, b.phone, b.orderAmount);
  }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post() create(@Body() b: any) { return this.c.create(b); }
}

@Module({ controllers: [CouponsController], providers: [CouponsService], exports: [CouponsService] })
export class CouponsModule {}
