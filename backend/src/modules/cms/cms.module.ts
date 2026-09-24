import {
  Module, Injectable, Controller, Get, Post, Body, Query, Param,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.module';
import { Public } from '../../common';

// ─── DTOs ───
class NewsletterDto {
  @IsEmail() email: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() source?: string;
}

// Setting groups the public website reads (index.html / admin login page):
// brand + contact + social links + stats counters + OTP UI limits.
export const PUBLIC_SETTING_GROUPS = ['general', 'contact', 'social', 'stats', 'operations'];
// Defence in depth: never serve a secret-looking key, whatever its group.
export const SECRET_SETTING_KEY = /(secret|password|passwd|token|api[_-]?key|private|webhook|credential)/i;

@Injectable()
export class CmsService {
  constructor(private prisma: PrismaService) {}

  async getBanners(city?: string) {
    const banners = await this.prisma.homeBanner.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!city) return banners;
    return banners.filter((b) => b.cityFilter.length === 0 || b.cityFilter.includes(city));
  }

  /**
   * PUBLIC settings — served unauthenticated to the website. Only groups the
   * public site actually reads are returned, and any secret-looking key is
   * dropped even inside them. Previously every row was returned, which served
   * the Razorpay key secret and webhook secret (group "payment") to anyone.
   * Server-side readers (payments, admin) query prisma.siteSetting directly and
   * are unaffected; the admin UI uses the authenticated GET /admin/settings.
   */
  async getSettings(group?: string) {
    if (group && !PUBLIC_SETTING_GROUPS.includes(group)) return {};
    const settings = await this.prisma.siteSetting.findMany({
      where: { group: group ? group : { in: PUBLIC_SETTING_GROUPS } },
    });
    const map: Record<string, string> = {};
    settings.forEach((s) => {
      if (!SECRET_SETTING_KEY.test(s.key)) map[s.key] = s.value;
    });
    return map;
  }

  async subscribeNewsletter(dto: NewsletterDto) {
    const existing = await this.prisma.newsletter.findUnique({ where: { email: dto.email } }).catch(() => null);
    if (existing) {
      if (!existing.isActive) {
        await this.prisma.newsletter.update({ where: { email: dto.email }, data: { isActive: true } });
        return { message: 'Successfully re-subscribed to newsletter!' };
      }
      return { message: 'Already subscribed.' };
    }
    await this.prisma.newsletter.create({
      data: { email: dto.email, name: dto.name || null, source: dto.source || 'WEBSITE' },
    });
    return { message: 'Successfully subscribed to newsletter!' };
  }

  async getFaqs(category?: string) {
    return this.prisma.faq.findMany({
      where: { isActive: true, ...(category ? { category } : {}) },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    }).catch(() => []);
  }

  async getBlogs(limit = 10, offset = 0) {
    return this.prisma.blogPost.findMany({
      where: { isPublished: true },
      select: { id: true, title: true, slug: true, summary: true, imageUrl: true, author: true, tags: true, publishedAt: true },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      skip: offset,
    }).catch(() => []);
  }

  async getBlogBySlug(slug: string) {
    const post = await this.prisma.blogPost.findUnique({ where: { slug } });
    if (!post || !post.isPublished) return null;
    return post;
  }

  async getAds(type?: string, city?: string) {
    const now = new Date();
    const ads = await this.prisma.seasonalAd.findMany({
      where: {
        isActive: true,
        ...(type ? { type } : {}),
        OR: [{ startDate: null }, { startDate: { lte: now } }],
        AND: [
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
        ],
      },
      orderBy: { sortOrder: 'asc' },
    }).catch(() => []);
    if (!city) return ads;
    return ads.filter((a: any) => !a.cityFilter?.length || a.cityFilter.includes(city));
  }
}

@ApiTags('CMS')
@Public()
@Controller('cms')
export class CmsController {
  constructor(private cms: CmsService) {}

  @Get('banners')
  banners(@Query('city') city?: string) { return this.cms.getBanners(city); }

  @Get('settings')
  settings(@Query('group') group?: string) { return this.cms.getSettings(group); }

  @Post('newsletter')
  subscribe(@Body() dto: NewsletterDto) { return this.cms.subscribeNewsletter(dto); }

  @Get('faqs')
  faqs(@Query('category') category?: string) { return this.cms.getFaqs(category); }

  @Get('blogs')
  blogs(@Query('limit') limit?: number, @Query('offset') offset?: number) {
    return this.cms.getBlogs(limit ? +limit : 10, offset ? +offset : 0);
  }

  @Get('blogs/:slug')
  blog(@Param('slug') slug: string) { return this.cms.getBlogBySlug(slug); }

  @Get('ads')
  ads(@Query('type') type?: string, @Query('city') city?: string) { return this.cms.getAds(type, city); }
}

@Module({
  controllers: [CmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
