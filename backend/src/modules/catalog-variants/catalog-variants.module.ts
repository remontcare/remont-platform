import {
  Module, Injectable, Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, UseGuards,
  BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsIn, IsOptional, IsBoolean, IsArray, IsObject, MaxLength, ValidateNested, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CatalogEntityType, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, Roles, RolesGuard } from '../../common';
import {
  normalizeOptionNames, validateMembers, suggestVariantGroups, describeOptions, MemberInput, normalizeListingImages,
} from './variant-rules';

class VariantMemberDto {
  @IsString() id: string;
  // Decorated so the global whitelist keeps it; keys/values are checked by validateMembers().
  @IsObject() options: Record<string, string>;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

class CreateVariantGroupDto {
  @IsIn(['PRODUCT', 'SERVICE']) entityType: CatalogEntityType;
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(3000) description?: string;
  @IsArray() optionNames: string[];
  @IsOptional() @IsArray() images?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariantMemberDto) members?: VariantMemberDto[];
}

class UpdateVariantGroupDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(3000) description?: string;
  @IsOptional() @IsArray() optionNames?: string[];
  @IsOptional() @IsArray() images?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  // When given, replaces the member list (rows left out are unlinked, never deleted).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariantMemberDto) members?: VariantMemberDto[];
}

class SetMembersDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => VariantMemberDto) members: VariantMemberDto[];
}

const MEMBER_SERVICE_SELECT = {
  id: true, name: true, slug: true, categoryId: true, basePrice: true, offerPrice: true, originalPrice: true,
  unit: true, durationMinutes: true, isActive: true, imageUrl: true, variantOptions: true, variantSortOrder: true,
} as const;
const MEMBER_PRODUCT_SELECT = {
  id: true, name: true, slug: true, sku: true, categoryId: true, price: true, mrp: true, stock: true, unit: true,
  isActive: true, images: true, brand: true, variantOptions: true, variantSortOrder: true,
} as const;

@Injectable()
export class CatalogVariantsService {
  constructor(private prisma: PrismaService) {}

  private async loadRows(entityType: CatalogEntityType, ids: string[]) {
    if (!ids.length) return [];
    return entityType === 'SERVICE'
      ? this.prisma.service.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, categoryId: true, variantGroupId: true } })
      : this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, categoryId: true, variantGroupId: true } });
  }

  private validate(groupId: string | null, optionNames: string[], members: MemberInput[], rows: any[]) {
    try {
      return validateMembers(groupId, optionNames, members, rows);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  private names(raw: unknown): string[] {
    try { return normalizeOptionNames(raw); } catch (e: any) { throw new BadRequestException(e.message); }
  }

  private images(raw: unknown): string[] {
    try { return normalizeListingImages(raw); } catch (e: any) { throw new BadRequestException(e.message); }
  }

  /** Writes the member list in one transaction: listed rows get their options, others are unlinked. */
  private async writeMembers(tx: any, entityType: CatalogEntityType, groupId: string, assigned: { id: string; options: any; sortOrder: number }[]) {
    const model = entityType === 'SERVICE' ? tx.service : tx.product;
    const keep = assigned.map((a) => a.id);
    await model.updateMany({
      where: { variantGroupId: groupId, id: { notIn: keep } },
      data: { variantGroupId: null, variantOptions: null, variantSortOrder: 0 },
    });
    for (const a of assigned) {
      await model.update({ where: { id: a.id }, data: { variantGroupId: groupId, variantOptions: a.options, variantSortOrder: a.sortOrder } });
    }
  }

  async list(entityType?: string, q?: string) {
    const where: any = {};
    if (entityType === 'SERVICE' || entityType === 'PRODUCT') where.entityType = entityType;
    if (q && q.trim()) where.name = { contains: q.trim(), mode: 'insensitive' };
    return this.prisma.catalogVariantGroup.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        services: { select: MEMBER_SERVICE_SELECT, orderBy: { variantSortOrder: 'asc' } },
        products: { select: MEMBER_PRODUCT_SELECT, orderBy: { variantSortOrder: 'asc' } },
      },
    });
  }

  async get(id: string) {
    const g = await this.prisma.catalogVariantGroup.findUnique({
      where: { id },
      include: {
        services: { select: MEMBER_SERVICE_SELECT, orderBy: { variantSortOrder: 'asc' } },
        products: { select: MEMBER_PRODUCT_SELECT, orderBy: { variantSortOrder: 'asc' } },
      },
    });
    if (!g) throw new NotFoundException('Variant group not found');
    return g;
  }

  async create(dto: CreateVariantGroupDto, adminId: string) {
    const optionNames = this.names(dto.optionNames);
    const images = this.images(dto.images);
    const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('Name is required');
    const members = dto.members || [];
    const rows = await this.loadRows(dto.entityType, members.map((m) => m.id));
    const assigned = this.validate(null, optionNames, members, rows);
    return this.prisma.$transaction(async (tx) => {
      const g = await tx.catalogVariantGroup.create({
        data: { entityType: dto.entityType, name, description: dto.description?.trim() || null, optionNames, images, isActive: dto.isActive ?? true, createdBy: adminId },
      });
      if (assigned.length) await this.writeMembers(tx, dto.entityType, g.id, assigned);
      return g;
    }).then((g) => this.get(g.id));
  }

  async update(id: string, dto: UpdateVariantGroupDto) {
    const g = await this.prisma.catalogVariantGroup.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('Variant group not found');
    const optionNames = dto.optionNames !== undefined ? this.names(dto.optionNames) : g.optionNames;
    const images = dto.images !== undefined ? this.images(dto.images) : undefined;
    let assigned: ReturnType<CatalogVariantsService['validate']> | null = null;
    if (dto.members !== undefined) {
      const rows = await this.loadRows(g.entityType, dto.members.map((m) => m.id));
      assigned = this.validate(id, optionNames, dto.members, rows);
    } else if (dto.optionNames !== undefined) {
      // Renaming/adding options must not leave existing members with missing values.
      const current = await this.currentMembers(g.entityType, id);
      assigned = this.validate(id, optionNames, current.map((m) => ({ id: m.id, options: m.variantOptions, sortOrder: m.variantSortOrder })), current);
    }
    if (dto.name !== undefined && !String(dto.name).trim()) throw new BadRequestException('Name is required');
    await this.prisma.$transaction(async (tx) => {
      await tx.catalogVariantGroup.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(images !== undefined ? { images } : {}),
          optionNames,
        },
      });
      if (assigned) await this.writeMembers(tx, g.entityType, id, assigned);
    });
    return this.get(id);
  }

  async setMembers(id: string, members: VariantMemberDto[]) {
    return this.update(id, { members });
  }

  private async currentMembers(entityType: CatalogEntityType, groupId: string) {
    const select = { id: true, name: true, categoryId: true, variantGroupId: true, variantOptions: true, variantSortOrder: true };
    return entityType === 'SERVICE'
      ? this.prisma.service.findMany({ where: { variantGroupId: groupId }, select })
      : this.prisma.product.findMany({ where: { variantGroupId: groupId }, select });
  }

  /** Unlinks every member (the rows stay exactly as they are), then removes the group. */
  async remove(id: string) {
    const g = await this.prisma.catalogVariantGroup.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('Variant group not found');
    await this.prisma.$transaction(async (tx) => {
      const model: any = g.entityType === 'SERVICE' ? tx.service : tx.product;
      await model.updateMany({ where: { variantGroupId: id }, data: { variantGroupId: null, variantOptions: null, variantSortOrder: 0 } });
      await tx.catalogVariantGroup.delete({ where: { id } });
    });
    return { ok: true };
  }

  /** Existing rows that look like options of one listing — proposals for admin review only. */
  async suggestions(entityType: string) {
    if (entityType === 'PRODUCT') {
      const rows = await this.prisma.product.findMany({
        where: { isActive: true, variantGroupId: null },
        select: { id: true, name: true, categoryId: true, price: true, brand: true, category: { select: { name: true } } },
      });
      return suggestVariantGroups(rows.map((r) => ({ id: r.id, name: r.name, categoryId: r.categoryId, price: Number(r.price) })))
        .map((s) => ({ ...s, entityType: 'PRODUCT', categoryName: rows.find((r) => r.categoryId === s.categoryId)?.category?.name || null }));
    }
    const rows = await this.prisma.service.findMany({
      where: { isActive: true, variantGroupId: null },
      select: { id: true, name: true, categoryId: true, basePrice: true, category: { select: { name: true } } },
    });
    return suggestVariantGroups(rows.map((r) => ({ id: r.id, name: r.name, categoryId: r.categoryId, price: Number(r.basePrice) })))
      .map((s) => ({ ...s, entityType: 'SERVICE', categoryName: rows.find((r) => r.categoryId === s.categoryId)?.category?.name || null }));
  }

  /** Public: an active group with its active members — the product page's Size/Colour data. */
  async publicGroup(id: string) {
    const g = await this.prisma.catalogVariantGroup.findFirst({
      where: { id, isActive: true },
      include: {
        services: { where: { isActive: true }, select: MEMBER_SERVICE_SELECT, orderBy: { variantSortOrder: 'asc' } },
        products: { where: { isActive: true }, select: MEMBER_PRODUCT_SELECT, orderBy: { variantSortOrder: 'asc' } },
      },
    });
    if (!g) throw new NotFoundException('Variant group not found');
    const members = g.entityType === 'SERVICE' ? g.services : g.products;
    return {
      id: g.id, entityType: g.entityType, name: g.name, description: g.description, images: g.images, optionNames: g.optionNames,
      members: members.map((m: any) => ({ ...m, variantLabel: describeOptions(g.optionNames, m.variantOptions) })),
    };
  }
}

// ─── Public read controller ───
@ApiTags('Catalog Variants')
@Public()
@Controller('catalog/variant-groups')
export class CatalogVariantsController {
  constructor(private svc: CatalogVariantsService) {}

  @Get(':id')
  one(@Param('id') id: string) { return this.svc.publicGroup(id); }
}

// ─── Admin controller ───
@ApiTags('Admin — Catalog Variants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/variant-groups')
export class AdminCatalogVariantsController {
  constructor(private svc: CatalogVariantsService) {}

  @Get()
  list(@Query('entityType') entityType?: string, @Query('q') q?: string) { return this.svc.list(entityType, q); }

  // Before ':id' — same path depth.
  @Get('suggestions')
  suggestions(@Query('entityType') entityType: string) {
    if (entityType !== 'PRODUCT' && entityType !== 'SERVICE') throw new BadRequestException('entityType must be PRODUCT or SERVICE');
    return this.svc.suggestions(entityType);
  }

  @Get(':id')
  one(@Param('id') id: string) { return this.svc.get(id); }

  @Post()
  create(@CurrentUser() u: JwtPayload, @Body() dto: CreateVariantGroupDto) { return this.svc.create(dto, u.sub); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateVariantGroupDto) { return this.svc.update(id, dto); }

  @Put(':id/members')
  members(@Param('id') id: string, @Body() dto: SetMembersDto) { return this.svc.setMembers(id, dto.members); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.svc.remove(id); }
}

@Module({
  controllers: [CatalogVariantsController, AdminCatalogVariantsController],
  providers: [CatalogVariantsService],
  exports: [CatalogVariantsService],
})
export class CatalogVariantsModule {}
