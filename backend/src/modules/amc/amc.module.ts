import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AmcPlanType, AmcStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public, CurrentUser, JwtPayload } from '../../common';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';

@Injectable()
export class AmcService {
  private readonly logger = new Logger(AmcService.name);
  constructor(
    private prisma: PrismaService,
    private payments: PaymentsService,
    private whatsapp: WhatsappService,
  ) {}

  // ─── Plans ───────────────────────────────────────────────────────────

  async listPlans(city?: string) {
    const plans = await this.prisma.amcPlan.findMany({
      where: { isActive: true },
      orderBy: [{ isPopular: 'desc' }, { priceYearly: 'asc' }],
    });
    if (!city) return plans;
    return plans.filter(
      (p) => !p.applicableCities?.length || p.applicableCities.includes(city),
    );
  }

  async getPlan(id: string) {
    const plan = await this.prisma.amcPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('AMC plan not found');
    return plan;
  }

  async createPlan(data: any) {
    return this.prisma.amcPlan.create({ data });
  }

  // ─── Subscriptions ───────────────────────────────────────────────────

  async subscribe(userId: string, planId: string, autoRenew = false) {
    const plan = await this.prisma.amcPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException();
    if (!plan.isActive) throw new BadRequestException('Plan inactive');

    // Check for existing active subscription
    const existing = await this.prisma.amcSubscription.findFirst({
      where: { userId, planId, status: AmcStatus.ACTIVE, endDate: { gt: new Date() } },
    });
    if (existing) {
      throw new BadRequestException('Already have an active subscription for this plan');
    }

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + plan.durationMonths);

    const count = await this.prisma.amcSubscription.count();
    const subscriptionNumber = `AMC-${(count + 1).toString().padStart(6, '0')}`;

    const subscription = await this.prisma.amcSubscription.create({
      data: {
        subscriptionNumber, userId, planId,
        startDate, endDate,
        amountPaid: plan.priceYearly,
        status: AmcStatus.ACTIVE,
        servicesRemaining: plan.freeServicesCount,
        autoRenew,
      },
      include: { plan: true, user: { select: { name: true, phone: true } } },
    });

    // Create Razorpay order
    const rzpOrder = await this.payments.createOrder(
      userId,
      Number(plan.priceYearly),
      undefined,
      subscription.id,
    );

    return { subscription, payment: rzpOrder };
  }

  async myActiveSubscriptions(userId: string) {
    return this.prisma.amcSubscription.findMany({
      where: { userId, status: AmcStatus.ACTIVE },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async useService(userId: string, subscriptionId: string) {
    const sub = await this.prisma.amcSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!sub || sub.userId !== userId) throw new NotFoundException();
    if (sub.status !== AmcStatus.ACTIVE) throw new BadRequestException('Subscription not active');
    if (sub.endDate < new Date()) throw new BadRequestException('Subscription expired');
    if (sub.servicesRemaining <= 0) throw new BadRequestException('No services remaining');

    return this.prisma.amcSubscription.update({
      where: { id: subscriptionId },
      data: {
        servicesUsed: { increment: 1 },
        servicesRemaining: { decrement: 1 },
      },
    });
  }

  async renew(userId: string, subscriptionId: string) {
    const existing = await this.prisma.amcSubscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    if (!existing || existing.userId !== userId) throw new NotFoundException();

    const startDate = new Date(existing.endDate);
    const endDate = new Date(existing.endDate);
    endDate.setMonth(endDate.getMonth() + existing.plan.durationMonths);

    const count = await this.prisma.amcSubscription.count();
    const subscriptionNumber = `AMC-${(count + 1).toString().padStart(6, '0')}`;

    const renewed = await this.prisma.amcSubscription.create({
      data: {
        subscriptionNumber,
        userId, planId: existing.planId,
        startDate, endDate,
        amountPaid: existing.plan.priceYearly,
        status: AmcStatus.ACTIVE,
        servicesRemaining: existing.plan.freeServicesCount,
        renewedFromId: existing.id,
        autoRenew: existing.autoRenew,
      },
      include: { plan: true },
    });

    const payment = await this.payments.createOrder(
      userId, Number(existing.plan.priceYearly), undefined, renewed.id,
    );
    return { subscription: renewed, payment };
  }

  async cancel(userId: string, subscriptionId: string, reason: string) {
    const sub = await this.prisma.amcSubscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.userId !== userId) throw new NotFoundException();
    return this.prisma.amcSubscription.update({
      where: { id: subscriptionId },
      data: {
        status: AmcStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason,
        autoRenew: false,
      },
    });
  }

  // ─── Cron: Auto-renew + expiry check (runs daily at 6 AM) ───────────

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async dailyAmcCheck() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Mark expired subscriptions
    const expired = await this.prisma.amcSubscription.updateMany({
      where: { status: AmcStatus.ACTIVE, endDate: { lt: today } },
      data: { status: AmcStatus.EXPIRED },
    });
    if (expired.count) {
      this.logger.log(`📅 Marked ${expired.count} AMC subscriptions as expired`);
    }

    // Trigger auto-renewals (7 days before expiry)
    const renewalWindow = new Date();
    renewalWindow.setDate(renewalWindow.getDate() + 7);

    const toRenew = await this.prisma.amcSubscription.findMany({
      where: {
        status: AmcStatus.ACTIVE,
        autoRenew: true,
        endDate: { gte: today, lte: renewalWindow },
      },
      include: { user: true, plan: true },
    });

    for (const sub of toRenew) {
      try {
        await this.renew(sub.userId, sub.id);
        this.logger.log(`🔄 Auto-renewed AMC ${sub.subscriptionNumber}`);
      } catch (e) {
        this.logger.warn(`Auto-renew failed for ${sub.subscriptionNumber}: ${e.message}`);
      }
    }
  }
}

@ApiTags('AMC')
@Controller('amc')
export class AmcController {
  constructor(private amc: AmcService) {}

  // ─── Public ───
  @Public() @Get('plans')
  plans(@Query('city') city?: string) { return this.amc.listPlans(city); }

  @Public() @Get('plans/:id')
  plan(@Param('id') id: string) { return this.amc.getPlan(id); }

  // ─── Customer ───
  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('subscribe')
  subscribe(@CurrentUser() u: JwtPayload, @Body() b: { planId: string; autoRenew?: boolean }) {
    return this.amc.subscribe(u.sub, b.planId, b.autoRenew);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Get('mine')
  mine(@CurrentUser() u: JwtPayload) { return this.amc.myActiveSubscriptions(u.sub); }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post(':id/use-service')
  use(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.amc.useService(u.sub, id);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post(':id/renew')
  renew(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.amc.renew(u.sub, id);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Patch(':id/cancel')
  cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: { reason: string }) {
    return this.amc.cancel(u.sub, id, b.reason);
  }

  // ─── Admin ───
  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Post('plans')
  createPlan(@Body() b: any) { return this.amc.createPlan(b); }
}

@Module({
  imports: [PaymentsModule, WhatsappModule],
  controllers: [AmcController],
  providers: [AmcService],
  exports: [AmcService],
})
export class AmcModule {}
