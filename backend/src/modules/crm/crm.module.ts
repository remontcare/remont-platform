import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
  NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LeadSource, LeadStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, Public } from '../../common';

@Injectable()
export class CrmService {
  constructor(private prisma: PrismaService) {}

  // ─── Lead lifecycle ─────────────────────────────────────────────

  /**
   * Capture a new lead from ANY source (AI chat, web form, WhatsApp, phone call).
   * Auto-links to existing user if phone matches.
   */
  async captureLead(data: {
    customerName: string;
    customerPhone: string;
    customerEmail?: string;
    cityName?: string;
    source: LeadSource;
    serviceInterested?: string;
    estimatedValue?: number;
    notes?: string;
    aiSessionId?: string;
    utmSource?: string;
    utmCampaign?: string;
    utmMedium?: string;
  }) {
    const existing = await this.prisma.user.findUnique({ where: { phone: data.customerPhone } });
    return this.prisma.lead.create({
      data: {
        ...data,
        customerUserId: existing?.id,
        status: LeadStatus.NEW,
      },
    });
  }

  async assignAgent(leadId: string, agentId: string) {
    return this.prisma.lead.update({
      where: { id: leadId },
      data: { assignedAgentId: agentId, status: LeadStatus.CONTACTED },
    });
  }

  async updateStatus(leadId: string, status: LeadStatus, notes?: string, lostReason?: string) {
    return this.prisma.lead.update({
      where: { id: leadId },
      data: {
        status, notes,
        ...(status === LeadStatus.LOST ? { lostReason } : {}),
        ...(status === LeadStatus.CONVERTED ? { convertedAt: new Date() } : {}),
      },
    });
  }

  /** Link a lead to a successfully created order */
  async markConverted(leadId: string, orderId: string) {
    return this.prisma.lead.update({
      where: { id: leadId },
      data: {
        status: LeadStatus.CONVERTED,
        convertedAt: new Date(),
        convertedOrderId: orderId,
      },
    });
  }

  async logActivity(agentId: string, leadId: string, data: {
    type: string;
    notes: string;
    outcome?: string;
    nextAction?: string;
    scheduledAt?: Date;
  }) {
    const activity = await this.prisma.crmActivity.create({
      data: { ...data, leadId, agentId },
    });
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { lastContactedAt: new Date(), nextFollowUpAt: data.scheduledAt },
    });
    return activity;
  }

  // ─── Queries ─────────────────────────────────────────────────────

  async listLeads(opts: { status?: LeadStatus; agentId?: string; source?: LeadSource; limit?: number }) {
    return this.prisma.lead.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.agentId ? { assignedAgentId: opts.agentId } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
      include: {
        agent: { select: { name: true } },
        activities: { take: 3, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
    });
  }

  async getLead(leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        agent: true, customer: true,
        activities: { include: { agent: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
        orders: true,
      },
    });
    if (!lead) throw new NotFoundException();
    return lead;
  }

  async myLeads(agentId: string) {
    return this.listLeads({ agentId });
  }

  // ─── Funnel & analytics ──────────────────────────────────────────

  async funnelStats(startDate?: Date, endDate?: Date) {
    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [total, byStatus, bySource, totalValue, conversions] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.groupBy({
        by: ['status'], where, _count: true,
      }),
      this.prisma.lead.groupBy({
        by: ['source'], where, _count: true,
      }),
      this.prisma.lead.aggregate({ where, _sum: { estimatedValue: true } }),
      this.prisma.lead.count({ where: { ...where, status: LeadStatus.CONVERTED } }),
    ]);

    return {
      total,
      byStatus: byStatus.reduce((m, s) => ({ ...m, [s.status]: s._count }), {} as Record<string, number>),
      bySource: bySource.reduce((m, s) => ({ ...m, [s.source]: s._count }), {} as Record<string, number>),
      totalEstimatedValue: totalValue._sum.estimatedValue || 0,
      conversionRate: total > 0 ? ((conversions / total) * 100).toFixed(1) + '%' : '0%',
    };
  }

  async agentPerformance(agentId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const [assigned, converted, activities] = await Promise.all([
      this.prisma.lead.count({ where: { assignedAgentId: agentId, createdAt: { gte: since } } }),
      this.prisma.lead.count({
        where: { assignedAgentId: agentId, status: LeadStatus.CONVERTED, convertedAt: { gte: since } },
      }),
      this.prisma.crmActivity.count({ where: { agentId, createdAt: { gte: since } } }),
    ]);
    return {
      assigned, converted, activities,
      conversionRate: assigned > 0 ? ((converted / assigned) * 100).toFixed(1) + '%' : '0%',
    };
  }
}

@ApiTags('CRM')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Controller('crm')
export class CrmController {
  constructor(private crm: CrmService) {}

  // ─── Public lead capture (used by AI chat, web forms, WhatsApp bots) ───
  @Public() @Post('leads/capture')
  capture(@Body() data: any) { return this.crm.captureLead(data); }

  // ─── Authenticated agent endpoints ───
  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('leads')
  list(
    @Query('status') status?: LeadStatus,
    @Query('agentId') agentId?: string,
    @Query('source') source?: LeadSource,
    @Query('limit') limit?: number,
  ) { return this.crm.listLeads({ status, agentId, source, limit }); }

  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('leads/mine')
  mine(@CurrentUser() u: JwtPayload) { return this.crm.myLeads(u.sub); }

  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('leads/:id')
  one(@Param('id') id: string) { return this.crm.getLead(id); }

  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch('leads/:id/assign')
  assign(@Param('id') id: string, @Body() b: { agentId: string }) {
    return this.crm.assignAgent(id, b.agentId);
  }

  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch('leads/:id/status')
  status(@Param('id') id: string, @Body() b: { status: LeadStatus; notes?: string; lostReason?: string }) {
    return this.crm.updateStatus(id, b.status, b.notes, b.lostReason);
  }

  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('leads/:id/activity')
  activity(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() b: any) {
    return this.crm.logActivity(u.sub, id, b);
  }

  // ─── Analytics ───
  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('analytics/funnel')
  funnel(@Query('startDate') s?: string, @Query('endDate') e?: string) {
    return this.crm.funnelStats(s ? new Date(s) : undefined, e ? new Date(e) : undefined);
  }

  @Roles(UserRole.CRM_AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('analytics/agent/:agentId')
  agentPerf(@Param('agentId') id: string, @Query('days') days?: number) {
    return this.crm.agentPerformance(id, days || 30);
  }
}

@Module({
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
