import { Module, Injectable, Controller, Get, Post, Body, Param, UseGuards, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class MembershipsService {
  constructor(private prisma: PrismaService) {}

  async listPlans() {
    return this.prisma.membershipPlan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: 'asc' } });
  }
  async getPlan(id: string) {
    const p = await this.prisma.membershipPlan.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    return p;
  }

  async subscribe(userId: string, planId: string, billing: 'MONTHLY' | 'YEARLY', paymentId?: string) {
    const plan = await this.prisma.membershipPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException();
    const existing = await this.prisma.userMembership.findUnique({ where: { userId } });
    if (existing && existing.isActive && existing.endDate > new Date()) {
      throw new BadRequestException('Already subscribed');
    }
    const amount = billing === 'MONTHLY' ? plan.priceMonthly : plan.priceYearly;
    const months = billing === 'MONTHLY' ? 1 : 12;
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + months);

    return this.prisma.userMembership.upsert({
      where: { userId },
      update: { planId, endDate, isActive: true, amountPaid: amount, paymentId, freeServicesUsed: 0 },
      create: { userId, planId, endDate, amountPaid: amount, paymentId },
      include: { plan: true },
    });
  }

  async getActiveDiscount(userId: string): Promise<number> {
    const m = await this.prisma.userMembership.findUnique({ where: { userId }, include: { plan: true } });
    if (!m || !m.isActive || m.endDate < new Date()) return 0;
    return m.plan.discountPercent;
  }
}

@ApiTags('Memberships')
@Controller('memberships')
export class MembershipsController {
  constructor(private m: MembershipsService) {}
  @Public() @Get('plans') list() { return this.m.listPlans(); }
  @Public() @Get('plans/:id') one(@Param('id') id: string) { return this.m.getPlan(id); }
  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('subscribe')
  subscribe(@CurrentUser() u: JwtPayload, @Body() b: { planId: string; billing: 'MONTHLY' | 'YEARLY'; paymentId?: string }) {
    return this.m.subscribe(u.sub, b.planId, b.billing, b.paymentId);
  }
}

@Module({ controllers: [MembershipsController], providers: [MembershipsService], exports: [MembershipsService] })
export class MembershipsModule {}
