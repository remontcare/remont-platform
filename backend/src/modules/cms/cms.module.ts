import { Module, Injectable, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { Public } from '../../common';

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

  async getSettings(group?: string) {
    const settings = await this.prisma.siteSetting.findMany({
      where: group ? { group } : {},
    });
    const map: Record<string, string> = {};
    settings.forEach((s) => { map[s.key] = s.value; });
    return map;
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
}

@Module({
  controllers: [CmsController],
  providers: [CmsService],
})
export class CmsModule {}
