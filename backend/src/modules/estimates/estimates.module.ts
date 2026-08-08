import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole, LeadSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public } from '../../common';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { CrmService, CrmModule } from '../crm/crm.module';
import { generateEstimate, EstimateEngineError, ModifierSelection } from './estimate-engine';

// ─── DTOs (kept loose/`any`-bodied like the rest of this codebase's public
//     endpoints, e.g. CrmController.capture — validated by hand below) ──────
interface EstimateRequestDto {
  serviceId: string;
  city?: string;
  sqft?: number;
  modifiers?: ModifierSelection[];
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
}

@Injectable()
export class EstimatesService {
  constructor(
    private prisma: PrismaService,
    private cities: CitiesService,
    private crm: CrmService,
  ) {}

  async estimate(dto: EstimateRequestDto) {
    if (!dto.serviceId) throw new BadRequestException('serviceId is required');

    // Capture the lead FIRST (if the customer provided contact details) so the
    // Estimate row can be linked to it in the same write — same public,
    // already-live capture path used by AI chat / WhatsApp / the Interior page's
    // city-not-serviceable form (POST /api/v1/crm/leads/capture).
    let leadId: string | undefined;
    if (dto.customerName && dto.customerPhone) {
      const lead = await this.crm.captureLead({
        customerName: dto.customerName,
        customerPhone: dto.customerPhone,
        customerEmail: dto.customerEmail,
        cityName: dto.city,
        source: LeadSource.ESTIMATE_ENGINE,
        serviceInterested: dto.serviceId,
      });
      leadId = lead.id;
    }

    try {
      return await generateEstimate(this.prisma, this.cities, {
        serviceId: dto.serviceId,
        city: dto.city,
        sqft: dto.sqft,
        modifiers: dto.modifiers,
        leadId,
      });
    } catch (e) {
      if (e instanceof EstimateEngineError) {
        if (e.code === 'SERVICE_NOT_FOUND') throw new NotFoundException(e.message);
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }

  // Modifier OPTIONS for a service/category — lets the frontend render its
  // size/finish/etc. selectors from live, admin-managed data instead of a
  // hardcoded list. Grouped by `group` for direct use as <select> options.
  async listModifierOptions(serviceId?: string, categoryId?: string) {
    if (!serviceId && !categoryId) throw new BadRequestException('serviceId or categoryId is required');
    let resolvedCategoryId = categoryId;
    if (serviceId && !categoryId) {
      const svc = await this.prisma.service.findUnique({ where: { id: serviceId }, select: { categoryId: true } });
      if (!svc) throw new NotFoundException('Service not found');
      resolvedCategoryId = svc.categoryId;
    }
    const rows = await this.prisma.servicePriceModifier.findMany({
      where: {
        isActive: true,
        OR: [{ serviceId: serviceId || undefined }, { categoryId: resolvedCategoryId, serviceId: null }],
      },
      orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
    });
    const grouped: Record<string, Array<{ label: string; multiplier: number }>> = {};
    for (const r of rows) {
      grouped[r.group] = grouped[r.group] || [];
      grouped[r.group].push({ label: r.label, multiplier: Number(r.multiplier) });
    }
    return grouped;
  }

  // ── Admin CRUD for ServicePriceModifier — same shape/conventions as
  //    AdminService's TaxConfig CRUD (admin.module.ts), kept here instead so
  //    the whole Estimate Engine stays self-contained in one reviewable module. ──
  adminListModifiers() {
    return this.prisma.servicePriceModifier.findMany({ orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }] });
  }
  adminCreateModifier(data: any) {
    return this.prisma.servicePriceModifier.create({ data });
  }
  adminUpdateModifier(id: string, data: any) {
    return this.prisma.servicePriceModifier.update({ where: { id }, data });
  }
  adminDeleteModifier(id: string) {
    return this.prisma.servicePriceModifier.delete({ where: { id } });
  }
}

@ApiTags('Estimate Engine')
@Controller('estimate')
export class EstimatesController {
  constructor(private estimates: EstimatesService) {}

  @Public() @Post()
  estimate(@Body() dto: EstimateRequestDto) {
    return this.estimates.estimate(dto);
  }

  @Public() @Get('modifiers')
  modifiers(@Query('serviceId') serviceId?: string, @Query('categoryId') categoryId?: string) {
    return this.estimates.listModifierOptions(serviceId, categoryId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Get('admin/modifiers')
  adminList() { return this.estimates.adminListModifiers(); }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Post('admin/modifiers')
  adminCreate(@Body() data: any) { return this.estimates.adminCreateModifier(data); }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Patch('admin/modifiers/:id')
  adminUpdate(@Param('id') id: string, @Body() data: any) { return this.estimates.adminUpdateModifier(id, data); }

  @UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth() @Delete('admin/modifiers/:id')
  adminDelete(@Param('id') id: string) { return this.estimates.adminDeleteModifier(id); }
}

@Module({
  imports: [CitiesModule, CrmModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
  exports: [EstimatesService],
})
export class EstimatesModule {}
