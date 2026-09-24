import {
  Module, Injectable, Controller, Get, Post, Body, Query, Param, UseGuards,
  CanActivate, ExecutionContext, UnauthorizedException, ServiceUnavailableException,
  NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { ServicesModule, ServicesService } from '../services/services.module';
import { CitiesModule, CitiesService } from '../cities/cities.module';
import { EstimatesModule, EstimatesService } from '../estimates/estimates.module';
import { CmsModule, CmsService } from '../cms/cms.module';
import { AmcModule, AmcService } from '../amc/amc.module';

/**
 * AI CATALOG — a narrow, read-mostly, server-to-server API for the Remont One
 * CRM's WhatsApp AI agent. The website stays the source of truth for the
 * catalogue; the CRM never touches this database.
 *
 *   GET  /api/v1/ai-catalog/categories
 *   GET  /api/v1/ai-catalog/services/search?q=&limit=
 *   GET  /api/v1/ai-catalog/services/:id
 *   POST /api/v1/ai-catalog/price              { serviceId, city?, sqft? }
 *   GET  /api/v1/ai-catalog/service-area?pincode=|city=
 *   GET  /api/v1/ai-catalog/business-info
 *   GET  /api/v1/ai-catalog/faqs?q=
 *   GET  /api/v1/ai-catalog/amc-plans?city=
 *
 * AUTH: header `x-ai-catalog-key` must equal env AI_CATALOG_API_KEY (constant-
 * time compare). Unset env => every call is refused (fail closed).
 * EXPOSURE: only fields a customer may be told. Internal cost fields
 * (labourCost, materialCost, GST/HSN codes, commission, vendor data) are never
 * returned. Search/detail carry NO price — the only price source is POST
 * /price, which runs the website's own estimate engine (city overrides, offer
 * price, pricing type, GST), exactly like a quote on the website. That call
 * records an Estimate row, same as the website's AI chat quotes.
 */

const KEY_HEADER = 'x-ai-catalog-key';
const SERVICE_ID = /^[a-z0-9]{10,40}$/i;           // cuid
const CITY_NAME = /^[A-Za-z][A-Za-z .'-]{1,59}$/;

function digest(v: string) {
  return createHash('sha256').update(v, 'utf8').digest();
}

@Injectable()
export class AiCatalogKeyGuard implements CanActivate {
  private readonly logger = new Logger('AiCatalogKeyGuard');

  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env.AI_CATALOG_API_KEY || '').trim();
    if (expected.length < 32) {
      this.logger.error('AI catalog refused: AI_CATALOG_API_KEY is not configured (min 32 chars)');
      throw new ServiceUnavailableException('AI catalog is not configured');
    }
    const req = context.switchToHttp().getRequest();
    const presented = String(req.headers[KEY_HEADER] || '');
    // Hash both sides so timingSafeEqual gets equal lengths and leaks nothing.
    if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
      throw new UnauthorizedException('Invalid AI catalog key');
    }
    return true;
  }
}

class SearchQuery {
  @IsString() @Length(1, 100) q: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(10) limit?: number;
}

class AreaQuery {
  @IsOptional() @Matches(/^\d{6}$/) pincode?: string;
  @IsOptional() @Matches(CITY_NAME) city?: string;
}

class FaqQuery {
  @IsOptional() @IsString() @Length(1, 100) q?: string;
}

class CityQuery {
  @IsOptional() @Matches(CITY_NAME) city?: string;
}

class PriceBody {
  @IsString() @Matches(SERVICE_ID) serviceId: string;
  @IsOptional() @Matches(CITY_NAME) city?: string;
  @IsOptional() @IsNumber() @Min(1) @Max(1_000_000) sqft?: number;
}

const num = (v: any) => (v === null || v === undefined ? null : Number(v));

function faqList(raw: any): { question: string; answer: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f: any) => ({ question: String(f?.question ?? f?.q ?? ''), answer: String(f?.answer ?? f?.a ?? '') }))
    .filter((f) => f.question && f.answer)
    .slice(0, 10);
}

@Injectable()
export class AiCatalogService {
  constructor(
    private prisma: PrismaService,
    private services: ServicesService,
    private cities: CitiesService,
    private estimates: EstimatesService,
    private cms: CmsService,
    private amc: AmcService,
  ) {}

  async categories() {
    const cats = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        key: true, name: true, description: true,
        subCategories: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { key: true, name: true } },
      },
    });
    return cats;
  }

  async search(q: string, limit = 5) {
    // Reuses the website's own search, including its Hindi/Hinglish intent fallback.
    const rows: any[] = await this.services.search(q);
    return rows.slice(0, limit).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category ? { key: s.category.key, name: s.category.name } : null,
      unit: s.unit,
      pricingType: s.pricingType,
      durationMinutes: s.durationMinutes,
      isPopular: s.isPopular,
    }));
  }

  async service(id: string) {
    if (!SERVICE_ID.test(id)) throw new BadRequestException('invalid service id');
    const s = await this.prisma.service.findFirst({
      where: { id, isActive: true },
      select: {
        id: true, name: true, description: true, unit: true, inclusions: true, exclusions: true,
        durationMinutes: true, pricingType: true, serviceType: true, timelineMinDays: true,
        timelineMaxDays: true, faqJson: true,
        category: { select: { key: true, name: true } },
        subCategory: { select: { key: true, name: true } },
      },
    });
    if (!s) throw new NotFoundException('Service not found');
    const { faqJson, ...rest } = s;
    return { ...rest, faqs: faqList(faqJson) };
  }

  async price(body: PriceBody) {
    // The website's canonical quote: same engine the website/Remi use.
    const r: any = await this.estimates.estimate({ serviceId: body.serviceId, city: body.city, sqft: body.sqft } as any);
    return {
      serviceId: r.service?.id,
      serviceName: r.service?.name,
      pricingType: r.service?.pricingType,
      city: body.city ?? null,
      currency: 'INR',
      requiresQuotation: !!r.requiresQuotation,
      estimatedLow: r.estimatedCost ? num(r.estimatedCost.low) : null,
      estimatedHigh: r.estimatedCost ? num(r.estimatedCost.high) : null,
      consultationFee: num(r.breakdown?.consultationFee),
      siteVisitFee: num(r.breakdown?.siteVisitFee),
      gstPercent: num(r.breakdown?.gstPercent),
      finalPayableAmount: num(r.finalPayableAmount),
      timeline: r.timeline?.label ?? null,
      bookingEligible: r.bookingEligibility?.eligible ?? null,
      eligibilityMessage: r.bookingEligibility?.message ?? null,
    };
  }

  async serviceArea(q: AreaQuery) {
    if (q.pincode) {
      const r: any = await this.cities.checkServiceability(q.pincode);
      return { query: { pincode: q.pincode }, serviceable: !!r.serviceable, city: r.city?.name ?? null };
    }
    if (q.city) {
      const c: any = await this.cities.getByName(q.city);
      if (!c || !c.isActive) return { query: { city: q.city }, serviceable: false, city: null };
      return { query: { city: q.city }, serviceable: true, city: c.name, activeCategoryKeys: c.activeServiceKeys || [] };
    }
    const all = await this.prisma.city.findMany({ where: { isActive: true }, select: { name: true } });
    return { query: {}, serviceable: null, activeCities: all.map((c) => c.name) };
  }

  async businessInfo() {
    // Only public CMS groups (see CmsService.getSettings allowlist).
    const s: Record<string, string> = await this.cms.getSettings();
    return {
      name: s.site_name || null,
      tagline: s.site_tagline || null,
      description: s.site_description || null,
      supportPhone: s.support_phone || null,
      supportEmail: s.support_email || null,
      whatsappNumber: s.whatsapp_number || null,
      businessHours: s.business_hours || null,
    };
  }

  async faqs(q?: string) {
    const rows: any[] = await this.cms.getFaqs();
    const terms = (q || '').toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const scored = rows
      .map((f) => ({ f, score: terms.filter((t) => `${f.question} ${f.answer}`.toLowerCase().includes(t)).length }))
      .filter((x) => !terms.length || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return scored.map(({ f }) => ({ question: f.question, answer: f.answer, category: f.category }));
  }

  async amcPlans(city?: string) {
    const plans: any[] = await this.amc.listPlans(city);
    return plans.map((p) => ({
      id: p.id, type: p.type, name: p.name, description: p.description,
      durationMonths: p.durationMonths, priceYearly: num(p.priceYearly), priceMonthly: num(p.priceMonthly),
      includedServices: p.includedServices, freeServicesCount: p.freeServicesCount,
      discountPercent: p.discountPercent, prioritySupport: p.prioritySupport,
    }));
  }
}

@ApiExcludeController()
@ApiTags('AI Catalog')
@UseGuards(AiCatalogKeyGuard)
@Throttle({ default: { limit: 120, ttl: 60_000 } })
@Controller('ai-catalog')
export class AiCatalogController {
  constructor(private svc: AiCatalogService) {}

  @Get('categories') categories() { return this.svc.categories(); }
  @Get('services/search') search(@Query() q: SearchQuery) { return this.svc.search(q.q, q.limit ?? 5); }
  @Get('services/:id') service(@Param('id') id: string) { return this.svc.service(id); }
  @Post('price') price(@Body() body: PriceBody) { return this.svc.price(body); }
  @Get('service-area') area(@Query() q: AreaQuery) { return this.svc.serviceArea(q); }
  @Get('business-info') info() { return this.svc.businessInfo(); }
  @Get('faqs') faqs(@Query() q: FaqQuery) { return this.svc.faqs(q.q); }
  @Get('amc-plans') amc(@Query() q: CityQuery) { return this.svc.amcPlans(q.city); }
}

@Module({
  imports: [ServicesModule, CitiesModule, EstimatesModule, CmsModule, AmcModule],
  controllers: [AiCatalogController],
  providers: [AiCatalogService, AiCatalogKeyGuard],
})
export class AiCatalogModule {}
