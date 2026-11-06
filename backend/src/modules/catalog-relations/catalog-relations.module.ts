import {
  Module, Injectable, Controller, Get, Post, Delete, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsIn, IsOptional, IsInt, Min } from 'class-validator';
import { CatalogEntityType, CatalogRelationType, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, Roles, RolesGuard } from '../../common';
import { productCityReach } from '../products/products.module';
import {
  Anchor, Candidate, NO_SUGGESTION_STATUSES, autoProductCategories, autoServiceCategories, scoreAuto,
} from './order-suggestions';

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

  // ─── Customer: "You may also need" for open orders ───

  /**
   * Suggestions for each of the customer's open orders (one checkout = one group) — from the
   * moment it's bought until its invoice is issued (see order-suggestions.ts for the rules).
   * Only active, in-stock, city-available catalog rows; never anything already in that order.
   */
  async suggestionsForMyOrders(customerId: string, maxGroups = 5, perGroup = 8) {
    const svcCat = { select: { key: true, slug: true, isActive: true } };
    const orders = await this.prisma.order.findMany({
      where: { customerId, status: { notIn: [...NO_SUGGESTION_STATUSES] as any }, invoice: { is: null } },
      select: {
        id: true, orderNumber: true, masterOrderId: true,
        masterOrder: { select: { masterOrderNumber: true } },
        address: { select: { city: true } },
        service: { select: { id: true, name: true, category: svcCat } },
        serviceItems: { select: { service: { select: { id: true, name: true, category: svcCat } } } },
        items: { select: { product: { select: { id: true, name: true, category: { select: { key: true } } } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    type Group = { key: string; masterOrderNumber: string | null; orderIds: string[]; orderNumbers: string[]; city: string | null; anchors: Anchor[] };
    const groups: Group[] = [];
    const byKey = new Map<string, Group>();
    const svcKey = (c: { key: string; slug: string | null } | null | undefined) => String(c?.slug || c?.key || '');
    for (const o of orders) {
      const key = o.masterOrderId || o.id;
      let g = byKey.get(key);
      if (!g) {
        if (groups.length >= maxGroups) continue;
        g = { key, masterOrderNumber: o.masterOrder?.masterOrderNumber || null, orderIds: [], orderNumbers: [], city: o.address?.city || null, anchors: [] };
        byKey.set(key, g);
        groups.push(g);
      }
      g.orderIds.push(o.id);
      g.orderNumbers.push(o.orderNumber);
      if (!g.city && o.address?.city) g.city = o.address.city;
      const svcs = [o.service, ...o.serviceItems.map((si) => si.service)].filter(Boolean) as NonNullable<typeof o.service>[];
      for (const s of svcs) g.anchors.push({ kind: 'SERVICE', id: s.id, name: s.name, categoryKey: svcKey(s.category) });
      for (const it of o.items) if (it.product) g.anchors.push({ kind: 'PRODUCT', id: it.product.id, name: it.product.name, categoryKey: it.product.category?.key || '' });
    }
    if (!groups.length) return { groups: [] };

    // Curated edges for every anchor, both directions, in one query.
    const anchorsAll = groups.flatMap((g) => g.anchors);
    const ids = (k: 'PRODUCT' | 'SERVICE') => [...new Set(anchorsAll.filter((a) => a.kind === k).map((a) => a.id))];
    const ors: any[] = [];
    for (const k of ['PRODUCT', 'SERVICE'] as const) {
      if (!ids(k).length) continue;
      ors.push({ fromType: k, fromId: { in: ids(k) } }, { toType: k, toId: { in: ids(k) } });
    }
    const edges = ors.length ? await this.prisma.catalogRelation.findMany({ where: { isActive: true, OR: ors } }) : [];

    // AUTO candidate pools, restricted to the bridged categories and to what's actually sellable.
    const prodCatKeys = new Set(autoProductCategories(anchorsAll));
    const svcCatKeys = new Set(autoServiceCategories(anchorsAll));
    const [prodCats, svcCats] = await Promise.all([
      prodCatKeys.size ? this.prisma.productCategory.findMany({ where: { isActive: true }, select: { id: true, key: true } }) : Promise.resolve([] as never),
      svcCatKeys.size ? this.prisma.serviceCategory.findMany({ where: { isActive: true }, select: { id: true, key: true, slug: true } }) : Promise.resolve([] as never),
    ]);
    const prodCatIds = prodCats.filter((c) => prodCatKeys.has(c.key.toLowerCase())).map((c) => c.id);
    const svcCatIds = svcCats.filter((c) => svcCatKeys.has(svcKey(c).toLowerCase())).map((c) => c.id);

    const curatedIds = (k: 'PRODUCT' | 'SERVICE') =>
      edges.flatMap((e) => [e.fromType === k ? e.fromId : null, e.toType === k ? e.toId : null]).filter(Boolean) as string[];
    const productWhere: any[] = [];
    if (prodCatIds.length) productWhere.push({ categoryId: { in: prodCatIds } });
    if (curatedIds('PRODUCT').length) productWhere.push({ id: { in: curatedIds('PRODUCT') } });
    const serviceWhere: any[] = [];
    if (svcCatIds.length) serviceWhere.push({ categoryId: { in: svcCatIds } });
    if (curatedIds('SERVICE').length) serviceWhere.push({ id: { in: curatedIds('SERVICE') } });

    const [products, services] = await Promise.all([
      productWhere.length
        ? this.prisma.product.findMany({
            where: { isActive: true, stock: { gt: 0 }, category: { isActive: true }, OR: productWhere },
            include: { category: { select: { key: true, name: true } }, vendor: { select: { city: true } } },
            take: 300,
          })
        : Promise.resolve([] as never),
      serviceWhere.length
        ? this.prisma.service.findMany({
            where: { isActive: true, category: { isActive: true }, OR: serviceWhere },
            include: { category: { select: { key: true, slug: true, name: true } } },
            take: 300,
          })
        : Promise.resolve([] as never),
    ]);

    // City availability, per distinct order city (same Product Coverage rule as the catalog).
    const cityNames = [...new Set(groups.map((g) => g.city).filter(Boolean) as string[])];
    const cities = cityNames.length ? await this.prisma.city.findMany({ where: { name: { in: cityNames } }, select: { id: true, name: true } }) : [];
    const cityIds = cities.map((c) => c.id);
    const [cityProducts, cityServices] = await Promise.all([
      cityIds.length && products.length
        ? this.prisma.cityProduct.findMany({ where: { cityId: { in: cityIds }, productId: { in: products.map((p) => p.id) } }, select: { cityId: true, productId: true, isActive: true } })
        : Promise.resolve([] as never),
      cityIds.length && services.length
        ? this.prisma.cityService.findMany({ where: { cityId: { in: cityIds }, serviceId: { in: services.map((s) => s.id) }, isActive: false }, select: { cityId: true, serviceId: true } })
        : Promise.resolve([] as never),
    ]);
    const cityIdByName = new Map(cities.map((c) => [c.name, c.id]));
    const cpKey = new Map(cityProducts.map((r) => [`${r.cityId}:${r.productId}`, r]));
    const csOff = new Set(cityServices.map((r) => `${r.cityId}:${r.serviceId}`));
    const availableIn = (kind: 'PRODUCT' | 'SERVICE', id: string, cityName: string | null) => {
      const cityId = cityName ? cityIdByName.get(cityName) : undefined;
      if (!cityId) return true; // unresolvable/missing city — don't filter, same as the catalog list
      if (kind === 'SERVICE') return !csOff.has(`${cityId}:${id}`);
      const p = products.find((x) => x.id === id);
      return !!p && productCityReach(p, cpKey.get(`${cityId}:${id}`), cityName!.trim().toLowerCase()) !== null;
    };

    const entity = new Map<string, any>();
    for (const p of products) {
      entity.set(`PRODUCT:${p.id}`, {
        kind: 'PRODUCT', id: p.id, name: p.name, price: Number(p.price), unit: p.unit, imageUrl: p.images?.[0] || null,
        categoryName: p.category?.name || null, categoryKey: p.category?.key || '', vendorId: p.vendorId || null,
      });
    }
    for (const s of services) {
      entity.set(`SERVICE:${s.id}`, {
        kind: 'SERVICE', id: s.id, name: s.name, price: Number(s.basePrice), unit: s.unit, imageUrl: s.imageUrl || null,
        categoryName: s.category?.name || null, categoryKey: s.category?.key || '', inclusions: s.inclusions || [],
        _bridgeKey: svcKey(s.category),
      });
    }
    const candidates: Candidate[] = [...entity.values()].map((e) => ({
      kind: e.kind, id: e.id, name: e.name, price: e.price, categoryKey: e.kind === 'SERVICE' ? e._bridgeKey : e.categoryKey,
    }));

    const out = groups.map((g) => {
      const inOrder = new Set(g.anchors.map((a) => `${a.kind}:${a.id}`));
      const anchorName = new Map(g.anchors.map((a) => [`${a.kind}:${a.id}`, a.name]));
      const picked = new Map<string, any>();
      const names = new Set<string>(); // the same item listed by two sellers shows once (best-ranked wins)
      const add = (kind: string, id: string, relationType: CatalogRelationType, source: 'CURATED' | 'AUTO', forName: string) => {
        const key = `${kind}:${id}`;
        if (picked.has(key) || inOrder.has(key) || picked.size >= perGroup) return;
        const e = entity.get(key);
        if (!e || !availableIn(kind as any, id, g.city)) return;
        const nameKey = `${kind}:${String(e.name).trim().toLowerCase()}`;
        if (names.has(nameKey)) return;
        names.add(nameKey);
        const { _bridgeKey, ...pub } = e;
        picked.set(key, { ...pub, relationType, source, forName });
      };

      const curated = edges
        .map((e) => {
          const fwd = `${e.fromType}:${e.fromId}`, rev = `${e.toType}:${e.toId}`;
          if (anchorName.has(fwd)) return { kind: e.toType, id: e.toId, rt: e.relationType, so: e.sortOrder, forName: anchorName.get(fwd)! };
          if (anchorName.has(rev)) return { kind: e.fromType, id: e.fromId, rt: e.relationType, so: e.sortOrder, forName: anchorName.get(rev)! };
          return null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => RELATION_PRIORITY.indexOf(a.rt) - RELATION_PRIORITY.indexOf(b.rt) || a.so - b.so);
      curated.forEach((c) => add(c.kind, c.id, c.rt, 'CURATED', c.forName));

      // AUTO only for what admin hasn't curated — a curated anchor keeps exactly its curated list.
      const curatedAnchors = new Set(curated.map((c) => c.forName));
      const autoAnchors = g.anchors.filter((a) => !curatedAnchors.has(a.name));
      scoreAuto(autoAnchors, candidates).forEach((s) => add(s.kind, s.id, s.relationType, 'AUTO', s.forName));

      return { key: g.key, masterOrderNumber: g.masterOrderNumber, orderIds: g.orderIds, orderNumbers: g.orderNumbers, items: [...picked.values()] };
    });
    return { groups: out.filter((g) => g.items.length) };
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

// ─── Customer controller ───
@ApiTags('Catalog Recommendations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog/suggestions')
export class CustomerCatalogSuggestionsController {
  constructor(private svc: CatalogRelationsService) {}

  /** "You may also need" for the signed-in customer's own open (not yet invoiced) orders. */
  @Get('my-orders')
  mine(@CurrentUser() u: JwtPayload) {
    return this.svc.suggestionsForMyOrders(u.sub);
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
  controllers: [CatalogRelationsController, CustomerCatalogSuggestionsController, AdminCatalogRelationsController],
  providers: [CatalogRelationsService],
  exports: [CatalogRelationsService],
})
export class CatalogRelationsModule {}
