import { Module, Injectable, Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CouponType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class CouponsService {
  constructor(private prisma: PrismaService) {}

  async validate(code: string, userId: string, orderAmount: number) {
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
    const userUsage = await this.prisma.couponUsage.count({ where: { couponId: coupon.id, userId } });
    if (userUsage >= coupon.perUserLimit) return { valid: false, reason: 'Already used' };

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
      coupon: { id: coupon.id, code: coupon.code, type: coupon.type },
    };
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

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post() create(@Body() b: any) { return this.c.create(b); }
}

@Module({ controllers: [CouponsController], providers: [CouponsService], exports: [CouponsService] })
export class CouponsModule {}
