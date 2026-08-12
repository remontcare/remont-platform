import {
  Module, Injectable, Controller, Get, Post, Delete, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsIn, IsOptional, IsInt, Min } from 'class-validator';
import { CatalogEntityType, CatalogRelationType, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, Roles, RolesGuard } from '../../common';

// Sort order the read API groups/ranks by — matches the "Smart Priority" list
// (required first, related last). Kept here (not relying on enum declaration
// order) so re-ordering the Prisma enum later can't silently change ranking.
const RELATION_PRIORITY: CatalogRelationType[] = [
  CatalogRelationType.REQUIRED,
  CatalogRelationType.COMPATIBLE,
  CatalogRelationType.INSTALLATION_SERVICE,
  CatalogRelationType.FREQUENTLY_BOUGHT_TOGETHER,
  CatalogRelationType.RECOMMENDED,
  CatalogRelationType.RELATED,
];

class CreateCatalogRelationDto {
  @IsIn(['PRODUCT', 'SERVICE']) fromType: CatalogEntityType;
  @IsString() fromId: string;
  @IsIn(['PRODUCT', 'SERVICE']) toType: CatalogEntityType;
  @IsString() toId: string;
  @IsOptional() @IsIn(['REQUIRED', 'COMPATIBLE', 'INSTALLATION_SERVICE', 'FREQUENTLY_BOUGHT_TOGETHER', 'RECOMMENDED', 'RELATED'])
  relationType?: CatalogRelationType;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

// A resolved Product or Service, flattened to the fields a recommendation
// card actually needs — the read API returns this shape (not raw
// Product/Service rows) so Flutter never has to branch on kind to find a
// display name/price.
interface ResolvedEntity {
  kind: 'PRODUCT' | 'SERVICE';
  id: string;
  name: string;
  price: number;
  unit: string;
  imageUrl: string | null;
  inStock: boolean | null; // null for services (stock doesn't apply)
  categoryName: string | null;
}

@Injectable()
export class CatalogRelationsService {
  constructor(private prisma: PrismaService) {}

  private async resolveEntities(
    ids: { type: CatalogEntityType; id: string }[],
  ): Promise<Map<string, ResolvedEntity>> {
    const productIds = ids.filter((x) => x.type === 'PRODUCT').map((x) => x.id);
    const serviceIds = ids.filter((x) => x.type === 'SERVICE').map((x) => x.id);
    const [products, services] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({ where: { id: { in: productIds }, isActive: true }, include: { category: true } })
        : Promise.resolve([]),
      serviceIds.length
        ? this.prisma.service.findMany({ where: { id: { in: serviceIds }, isActive: true }, include: { category: true } })
        : Promise.resolve([]),
    ]);
    const map = new Map<string, ResolvedEntity>();
    for (const p of products) {
      map.set(`PRODUCT:${p.id}`, {
        kind: 'PRODUCT', id: p.id, name: p.name, price: Number(p.price), unit: p.unit,
        imageUrl: p.images?.[0] || null, inStock: p.stock > 0, categoryName: p.category?.name || null,
      });
    }
    for (const s of services) {
      map.set(`SERVICE:${s.id}`, {
        kind: 'SERVICE', id: s.id, name: s.name, price: Number(s.basePrice), unit: s.unit,
        imageUrl: s.imageUrl || null, inStock: null, categoryName: s.category?.name || null,
      });
    }
    return map;
  }

  /**
   * Fully resolved, ranked recommendations for one Product or Service —
   * one call, no further round-trips (each item already carries name/price/
   * image). Reads BOTH directions so a single admin-defined edge answers
   * "what does X need?" and "what needs X?" without duplicate rows — see
   * the CatalogRelation model comment in schema.prisma.
   */
  async getRecommendations(type: CatalogEntityType, id: string) {
    const [forward, reverse] = await Promise.all([
      this.prisma.catalogRelation.findMany({ where: { fromType: type, fromId: id, isActive: true } }),
      this.prisma.catalogRelation.findMany({ where: { toType: type, toId: id, isActive: true } }),
    ]);

    type Edge = { otherType: CatalogEntityType; otherId: string; relationType: CatalogRelationType; sortOrder: number };
    const edges: Edge[] = [
      ...forward.map((r) => ({ otherType: r.toType, otherId: r.toId, relationType: r.relationType, sortOrder: r.sortOrder })),
      ...reverse.map((r) => ({ otherType: r.fromType, otherId: r.fromId, relationType: r.relationType, sortOrder: r.sortOrder })),
    ];
    // De-dupe (a reverse+forward pair could theoretically both exist for the same pair/type)
    const seen = new Set<string>();
    const deduped = edges.filter((e) => {
      const key = `${e.otherType}:${e.otherId}:${e.relationType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const resolved = await this.resolveEntities(deduped.map((e) => ({ type: e.otherType, id: e.otherId })));

    const items = deduped
      .map((e) => {
        const entity = resolved.get(`${e.otherType}:${e.otherId}`);
        if (!entity) return null; // referenced row was deleted/deactivated since the relation was made
        return { relationType: e.relationType, sortOrder: e.sortOrder, ...entity };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => {
        const pa = RELATION_PRIORITY.indexOf(a.relationType);
        const pb = RELATION_PRIORITY.indexOf(b.relationType);
        if (pa !== pb) return pa - pb;
        return a.sortOrder - b.sortOrder;
      });

    return { type, id, items };
  }

  // ─── Admin ───

  async adminListFor(type: CatalogEntityType, id: string) {
    const [forward, reverse] = await Promise.all([
      this.prisma.catalogRelation.findMany({ where: { fromType: type, fromId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.catalogRelation.findMany({ where: { toType: type, toId: id }, orderBy: { createdAt: 'desc' } }),
    ]);
    const all = [...forward, ...reverse];
    const resolved = await this.resolveEntities(
      all.map((r) => (r.fromType === type && r.fromId === id ? { type: r.toType, id: r.toId } : { type: r.fromType, id: r.fromId })),
    );
    return all.map((r) => {
      const isForward = r.fromType === type && r.fromId === id;
      const otherType = isForward ? r.toType : r.fromType;
      const otherId = isForward ? r.toId : r.fromId;
      return { ...r, direction: isForward ? 'FORWARD' : 'REVERSE', other: resolved.get(`${otherType}:${otherId}`) || null };
    });
  }

  private async assertEntityExists(type: CatalogEntityType, id: string) {
    const exists =
      type === 'PRODUCT'
        ? await this.prisma.product.findUnique({ where: { id }, select: { id: true } })
        : await this.prisma.service.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException(`${type} ${id} not found`);
  }

  async createRelation(dto: CreateCatalogRelationDto, adminUserId: string) {
    if (dto.fromType === dto.toType && dto.fromId === dto.toId) {
      throw new BadRequestException('Cannot relate an item to itself');
    }
    await Promise.all([
      this.assertEntityExists(dto.fromType, dto.fromId),
      this.assertEntityExists(dto.toType, dto.toId),
    ]);
    return this.prisma.catalogRelation.upsert({
      where: {
        fromType_fromId_toType_toId_relationType: {
          fromType: dto.fromType, fromId: dto.fromId, toType: dto.toType, toId: dto.toId,
          relationType: dto.relationType || CatalogRelationType.RECOMMENDED,
        },
      },
      update: { sortOrder: dto.sortOrder ?? 0, isActive: true },
      create: {
        fromType: dto.fromType, fromId: dto.fromId, toType: dto.toType, toId: dto.toId,
        relationType: dto.relationType || CatalogRelationType.RECOMMENDED,
        sortOrder: dto.sortOrder ?? 0, createdBy: adminUserId,
      },
    });
  }

  async deleteRelation(id: string) {
    await this.prisma.catalogRelation.deleteMany({ where: { id } });
    return { deleted: true };
  }
}

// ─── Public read controller ───
@ApiTags('Catalog Recommendations')
@Public()
@Controller('catalog')
export class CatalogRelationsController {
  constructor(private svc: CatalogRelationsService) {}

  @Get('recommendations')
  get(@Query('type') type: string, @Query('id') id: string) {
    if (type !== 'PRODUCT' && type !== 'SERVICE') {
      throw new BadRequestException('type must be PRODUCT or SERVICE');
    }
    if (!id) throw new BadRequestException('id is required');
    return this.svc.getRecommendations(type as CatalogEntityType, id);
  }
}

// ─── Admin controller ───
@ApiTags('Admin — Catalog Relations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/catalog-relations')
export class AdminCatalogRelationsController {
  constructor(private svc: CatalogRelationsService) {}

  @Get()
  list(@Query('type') type: string, @Query('id') id: string) {
    if (type !== 'PRODUCT' && type !== 'SERVICE') {
      throw new BadRequestException('type must be PRODUCT or SERVICE');
    }
    if (!id) throw new BadRequestException('id is required');
    return this.svc.adminListFor(type as CatalogEntityType, id);
  }

  @Post()
  create(@CurrentUser() u: JwtPayload, @Body() dto: CreateCatalogRelationDto) {
    return this.svc.createRelation(dto, u.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.deleteRelation(id);
  }
}

@Module({
  controllers: [CatalogRelationsController, AdminCatalogRelationsController],
  providers: [CatalogRelationsService],
  exports: [CatalogRelationsService],
})
export class CatalogRelationsModule {}
