import {
  Module, Injectable, Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, Req,
  UseGuards, Logger, OnModuleInit, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, MaxLength, Min,
} from 'class-validator';
import { LegalPolicyStatus, LegalPolicyVersionStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, Public, logAudit, slugify } from '../../common';
import {
  sanitizeHtml, sanitizeText, renderVariables, findUnresolved, formatPolicyDate,
  LEGAL_VARIABLE_SETTINGS, MAX_SECTION_HTML, CRITICAL_VARIABLES,
} from './legal.sanitize';
import { POLICY_TEMPLATES, GENERIC_SECTIONS, SYSTEM_SLUGS, PolicySectionTemplate } from './legal.templates';

/**
 * LEGAL & POLICIES CMS
 *
 *   LegalPolicy (≈12 main documents) → LegalPolicyVersion → LegalPolicySection
 *
 * Rules enforced here (not in the UI):
 *  - Only DRAFT versions are editable. A PUBLISHED version is never modified.
 *  - At most one DRAFT and one PUBLISHED version per policy.
 *  - Publish archives the previously published version. First publish of a
 *    0.x draft becomes 1.0; drafts cut from x.y become x.(y+1).
 *  - Restore copies an old version into a NEW draft (v1.0 restored while v1.1
 *    is live → v1.2 draft). Nothing is ever hard-deleted — a discarded draft
 *    is archived.
 *  - Section HTML is sanitised on write and again on public render.
 *  - Every admin mutation is written to AuditLog (targetType "LegalPolicy").
 *
 * Admin API:  /api/v1/admin/legal/...   (ADMIN, SUPER_ADMIN)
 * Public API: /api/v1/legal/policies[/:key]  (no auth, published only)
 */

export const LEGAL_AUDIT_TARGET = 'LegalPolicy';
const EDITABLE = LegalPolicyVersionStatus.DRAFT;
const MAX_SECTIONS = 100;
const DEFAULT_WEBSITE = 'https://www.remontindia.com';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── DTOs ──────────────────────────────────────────────────────────────────
class CreatePolicyDto {
  @IsString() @Length(3, 120) title: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @Length(3, 80) @Matches(SLUG_RE, { message: 'slug may only contain lowercase letters, numbers and single hyphens' }) slug?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
class UpdatePolicyDto {
  @IsOptional() @IsString() @Length(3, 120) title?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(160) seoTitle?: string;
  @IsOptional() @IsString() @MaxLength(320) seoDescription?: string;
  @IsOptional() @IsBoolean() showInFooter?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
class UpdateVersionDto {
  @IsOptional() @IsDateString() effectiveDate?: string;
  @IsOptional() @IsString() @MaxLength(500) changeNote?: string;
}
class SectionDto {
  @IsOptional() @IsString() @Length(1, 160) title?: string;
  @IsOptional() @IsString() @MaxLength(MAX_SECTION_HTML) content?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() afterSectionId?: string;
}
class ReorderDto { @IsArray() @IsString({ each: true }) sectionIds: string[]; }
class PublishDto {
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() @MaxLength(500) changeNote?: string;
}
class RestoreDto { @IsOptional() @IsBoolean() replaceDraft?: boolean; }
class LegalInfoDto { @IsObject() values: Record<string, string>; }
class AcceptDto {
  @IsString() @MaxLength(80) policy: string;
  @IsOptional() @IsString() versionId?: string;
}
class ListQuery {
  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED', 'ALL']) status?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
}

type Actor = JwtPayload;

// ─── Acceptance helper (used by registration flows) ────────────────────────
/**
 * Records that a subject accepted the CURRENTLY PUBLISHED version of each
 * given policy (by slug). Policies that are not published are skipped — there
 * is no version text to point at. Never throws: consent capture must not be
 * able to break the flow that triggered it.
 */
export async function recordPolicyAcceptances(prisma: any, entry: {
  policySlugs: string[];
  subjectType: string;
  subjectId?: string;
  userId?: string | null;
  ip?: string;
  userAgent?: string;
}): Promise<number> {
  try {
    const policies = await prisma.legalPolicy.findMany({
      where: { slug: { in: entry.policySlugs }, status: LegalPolicyStatus.PUBLISHED, currentVersionId: { not: null } },
      select: { id: true, currentVersionId: true, currentVersion: true },
    });
    if (!policies.length) return 0;
    await prisma.policyAcceptance.createMany({
      data: policies.map((p: any) => ({
        policyId: p.id,
        versionId: p.currentVersionId,
        version: p.currentVersion || '',
        userId: entry.userId || null,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId || null,
        ip: entry.ip?.slice(0, 64) || null,
        userAgent: entry.userAgent?.slice(0, 300) || null,
      })),
    });
    return policies.length;
  } catch (e) {
    new Logger('PolicyAcceptance').warn(`Could not record policy acceptance (${entry.subjectType} ${entry.subjectId || ''}): ${(e as Error).message}`);
    return 0;
  }
}

// ─── Service ───────────────────────────────────────────────────────────────
@Injectable()
export class LegalService implements OnModuleInit {
  private readonly logger = new Logger(LegalService.name);
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.LEGAL_SKIP_SEED === 'true') return;
    try {
      const created = await this.ensureDefaultPolicies();
      if (created.length) this.logger.log(`Seeded default legal policies as v0.1 drafts: ${created.join(', ')}`);
    } catch (e) {
      // Never block boot (e.g. migration not applied yet) — the admin page can re-run this.
      this.logger.warn(`Default legal policy seeding skipped: ${(e as Error).message}`);
    }
  }

  /** Creates any missing built-in policy as a v0.1 draft. Never touches an existing one. */
  async ensureDefaultPolicies(): Promise<string[]> {
    const created: string[] = [];
    for (const t of POLICY_TEMPLATES) {
      const exists = await this.prisma.legalPolicy.findUnique({ where: { slug: t.slug }, select: { id: true } });
      if (exists) continue;
      try {
        await this.createPolicyWithDraft({
          slug: t.slug, publicPath: t.publicPath, policyType: t.policyType, category: t.category,
          title: t.title, description: t.description, seoTitle: t.seoTitle, seoDescription: t.seoDescription,
          sortOrder: t.sortOrder, isSystem: true,
        }, t.sections, null);
        created.push(t.slug);
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // another instance created it concurrently
      }
    }
    // Only values already verified on the live site/by the business are pre-filled.
    // Legal name, address, grievance officer, GSTIN etc. stay empty until an admin enters them.
    const defaults = { COMPANY_NAME: 'Remont India', WEBSITE_URL: DEFAULT_WEBSITE, PRIVACY_EMAIL: 'remont.care@gmail.com' };
    for (const [name, def] of Object.entries(defaults)) {
      const key = LEGAL_VARIABLE_SETTINGS[name].key;
      const row = await this.prisma.siteSetting.findUnique({ where: { key } });
      if (!row) await this.prisma.siteSetting.create({ data: { key, value: def, label: LEGAL_VARIABLE_SETTINGS[name].label, group: 'legal' } });
    }
    return created;
  }

  private async createPolicyWithDraft(data: any, sections: PolicySectionTemplate[], actorId: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.legalPolicy.create({ data: { ...data, createdById: actorId, status: LegalPolicyStatus.DRAFT } });
      const version = await tx.legalPolicyVersion.create({
        data: { policyId: policy.id, version: '0.1', major: 0, minor: 1, status: EDITABLE, createdById: actorId },
      });
      const used = new Set<string>();
      await tx.legalPolicySection.createMany({
        data: sections.map((s, i) => ({
          versionId: version.id, title: s.title, slug: uniqueSlug(s.title, used),
          content: sanitizeHtml(s.content), sortOrder: (i + 1) * 10, isActive: true,
        })),
      });
      return { policy, version };
    });
  }

  // ── Reads ──
  async list(query: ListQuery) {
    const where: any = {};
    if (query.status && query.status !== 'ALL') where.status = query.status;
    else if (!query.status) where.status = { not: LegalPolicyStatus.ARCHIVED };
    if (query.q) where.OR = [{ title: { contains: query.q, mode: 'insensitive' } }, { category: { contains: query.q, mode: 'insensitive' } }];
    const rows = await this.prisma.legalPolicy.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        versions: {
          where: { status: { in: [LegalPolicyVersionStatus.DRAFT, LegalPolicyVersionStatus.PUBLISHED] } },
          select: { id: true, version: true, status: true, updatedAt: true, _count: { select: { sections: true } } },
        },
      },
    });
    return rows.map(({ versions, ...p }) => {
      const draft = versions.find((v) => v.status === EDITABLE);
      const live = versions.find((v) => v.status === LegalPolicyVersionStatus.PUBLISHED);
      const working = draft || live;
      return {
        ...p,
        sectionCount: working?._count.sections ?? 0,
        draftVersion: draft ? { id: draft.id, version: draft.version, updatedAt: draft.updatedAt } : null,
        publishedVersion: live ? { id: live.id, version: live.version } : null,
        lastUpdated: draft && draft.updatedAt > p.updatedAt ? draft.updatedAt : p.updatedAt,
      };
    });
  }

  async findPolicy(idOrSlug: string) {
    const policy = await this.prisma.legalPolicy.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } });
    if (!policy) throw new NotFoundException('Policy not found');
    return policy;
  }

  async getPolicy(idOrSlug: string) {
    const policy = await this.findPolicy(idOrSlug);
    const versions = await this.prisma.legalPolicyVersion.findMany({
      where: { policyId: policy.id },
      orderBy: [{ major: 'desc' }, { minor: 'desc' }],
      include: { _count: { select: { sections: true } } },
    });
    const draft = versions.find((v) => v.status === EDITABLE);
    const workingId = draft?.id || policy.currentVersionId;
    const working = workingId ? await this.getVersion(workingId) : null;
    return {
      policy,
      versions: versions.map(({ _count, ...v }) => ({ ...v, sectionCount: _count.sections })),
      working,
      draftVersionId: draft?.id || null,
    };
  }

  async getVersion(versionId: string) {
    const v = await this.prisma.legalPolicyVersion.findUnique({
      where: { id: versionId },
      include: { sections: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!v) throw new NotFoundException('Version not found');
    return v;
  }

  private async draftOrThrow(versionId: string) {
    const v = await this.prisma.legalPolicyVersion.findUnique({ where: { id: versionId } });
    if (!v) throw new NotFoundException('Version not found');
    if (v.status !== EDITABLE) throw new BadRequestException(`Version ${v.version} is ${v.status.toLowerCase()} and cannot be edited — create a draft first.`);
    return v;
  }

  private async sectionInDraft(sectionId: string) {
    const s = await this.prisma.legalPolicySection.findUnique({ where: { id: sectionId }, include: { version: true } });
    if (!s) throw new NotFoundException('Section not found');
    if (s.version.status !== EDITABLE) throw new BadRequestException(`Sections of version ${s.version.version} cannot be edited — it is ${s.version.status.toLowerCase()}.`);
    return s;
  }

  // ── Policy CRUD ──
  async create(dto: CreatePolicyDto, actor: Actor) {
    const title = sanitizeText(dto.title, 120);
    const slug = dto.slug || slugify(title);
    if (!SLUG_RE.test(slug) || slug.length < 3) throw new BadRequestException('Please provide a valid slug (lowercase letters, numbers, hyphens).');
    if (SYSTEM_SLUGS.includes(slug)) throw new ConflictException('That slug belongs to a built-in policy.');
    const clash = await this.prisma.legalPolicy.findFirst({ where: { OR: [{ slug }, { publicPath: `/policy/${slug}` }] } });
    if (clash) throw new ConflictException(`A policy with slug "${slug}" already exists.`);
    const max = await this.prisma.legalPolicy.aggregate({ _max: { sortOrder: true } });
    const { policy } = await this.createPolicyWithDraft({
      slug, publicPath: `/policy/${slug}`, policyType: 'CUSTOM',
      category: sanitizeText(dto.category || 'General', 60) || 'General',
      title, description: dto.description ? sanitizeText(dto.description, 500) : null,
      seoTitle: `${title} | Remont India`, seoDescription: dto.description ? sanitizeText(dto.description, 300) : null,
      sortOrder: (max._max.sortOrder || 0) + 1, isSystem: false,
    }, GENERIC_SECTIONS, actor.sub);
    await this.audit(actor, 'LEGAL_POLICY_CREATED', policy.id, { slug, title });
    return this.getPolicy(policy.id);
  }

  async update(id: string, dto: UpdatePolicyDto, actor: Actor) {
    const policy = await this.findPolicy(id);
    const data: any = {};
    if (dto.title !== undefined) data.title = sanitizeText(dto.title, 120);
    if (dto.category !== undefined) data.category = sanitizeText(dto.category, 60) || 'General';
    if (dto.description !== undefined) data.description = sanitizeText(dto.description, 500) || null;
    if (dto.seoTitle !== undefined) data.seoTitle = sanitizeText(dto.seoTitle, 160) || null;
    if (dto.seoDescription !== undefined) data.seoDescription = sanitizeText(dto.seoDescription, 320) || null;
    if (dto.showInFooter !== undefined) data.showInFooter = dto.showInFooter;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (data.title === '') throw new BadRequestException('Title is required');
    const updated = await this.prisma.legalPolicy.update({ where: { id: policy.id }, data });
    await this.audit(actor, 'LEGAL_POLICY_UPDATED', policy.id, { fields: Object.keys(data) });
    return updated;
  }

  // ── Versions ──
  /** Next draft label: 0.x while never published, otherwise <latest major>.<next minor>. */
  static nextDraftLabel(versions: Array<{ major: number; minor: number }>): { major: number; minor: number } {
    if (!versions.length) return { major: 0, minor: 1 };
    const major = Math.max(...versions.map((v) => v.major));
    const minor = Math.max(...versions.filter((v) => v.major === major).map((v) => v.minor)) + 1;
    return { major, minor };
  }

  /** Returns the policy's draft, creating one (copied from the live or latest version) if needed. */
  async ensureDraft(policyId: string, actor: Actor) {
    const policy = await this.findPolicy(policyId);
    const existing = await this.prisma.legalPolicyVersion.findFirst({ where: { policyId: policy.id, status: EDITABLE } });
    if (existing) return this.getVersion(existing.id);
    const versions = await this.prisma.legalPolicyVersion.findMany({ where: { policyId: policy.id }, orderBy: [{ major: 'desc' }, { minor: 'desc' }] });
    const source = versions.find((v) => v.id === policy.currentVersionId) || versions[0];
    const draft = await this.copyToNewDraft(policy.id, source?.id || null, versions, actor, null);
    await this.audit(actor, 'LEGAL_POLICY_DRAFT_CREATED', policy.id, { versionId: draft.id, version: draft.version, fromVersion: source?.version || null });
    return this.getVersion(draft.id);
  }

  private async copyToNewDraft(policyId: string, sourceVersionId: string | null, versions: any[], actor: Actor, restoredFrom: string | null) {
    const { major, minor } = LegalService.nextDraftLabel(versions);
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.legalPolicyVersion.create({
        data: {
          policyId, version: `${major}.${minor}`, major, minor, status: EDITABLE,
          createdById: actor.sub, restoredFromVersionId: restoredFrom,
        },
      });
      if (sourceVersionId) {
        const sections = await tx.legalPolicySection.findMany({ where: { versionId: sourceVersionId }, orderBy: { sortOrder: 'asc' } });
        if (sections.length) {
          await tx.legalPolicySection.createMany({
            data: sections.map((s) => ({ versionId: draft.id, title: s.title, slug: s.slug, content: s.content, sortOrder: s.sortOrder, isActive: s.isActive })),
          });
        }
      }
      return draft;
    });
  }

  async updateVersion(versionId: string, dto: UpdateVersionDto, actor: Actor) {
    const v = await this.draftOrThrow(versionId);
    const updated = await this.prisma.legalPolicyVersion.update({
      where: { id: v.id },
      data: {
        ...(dto.effectiveDate !== undefined ? { effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : null } : {}),
        ...(dto.changeNote !== undefined ? { changeNote: sanitizeText(dto.changeNote, 500) || null } : {}),
      },
    });
    await this.audit(actor, 'LEGAL_VERSION_UPDATED', v.policyId, { versionId: v.id, version: v.version });
    return updated;
  }

  async discardDraft(versionId: string, actor: Actor) {
    const v = await this.draftOrThrow(versionId);
    await this.prisma.legalPolicyVersion.update({ where: { id: v.id }, data: { status: LegalPolicyVersionStatus.ARCHIVED, archivedAt: new Date() } });
    await this.audit(actor, 'LEGAL_DRAFT_DISCARDED', v.policyId, { versionId: v.id, version: v.version });
    return { discarded: true, version: v.version };
  }

  async restore(versionId: string, dto: RestoreDto, actor: Actor) {
    const source = await this.prisma.legalPolicyVersion.findUnique({ where: { id: versionId } });
    if (!source) throw new NotFoundException('Version not found');
    if (source.status === EDITABLE) throw new BadRequestException('This version is already the working draft.');
    const draft = await this.prisma.legalPolicyVersion.findFirst({ where: { policyId: source.policyId, status: EDITABLE } });
    if (draft) {
      if (!dto.replaceDraft) throw new ConflictException(`Draft v${draft.version} already exists. Discard it first, or restore with "replace draft".`);
      await this.discardDraft(draft.id, actor);
    }
    const versions = await this.prisma.legalPolicyVersion.findMany({ where: { policyId: source.policyId } });
    const created = await this.copyToNewDraft(source.policyId, source.id, versions, actor, source.id);
    await this.audit(actor, 'LEGAL_VERSION_RESTORED', source.policyId, { fromVersionId: source.id, fromVersion: source.version, newVersionId: created.id, newVersion: created.version });
    return this.getVersion(created.id);
  }

  // ── Sections ──
  async addSection(versionId: string, dto: SectionDto, actor: Actor) {
    const v = await this.draftOrThrow(versionId);
    const title = sanitizeText(dto.title || '', 160);
    if (!title) throw new BadRequestException('Section title is required');
    const sections = await this.prisma.legalPolicySection.findMany({ where: { versionId: v.id }, orderBy: { sortOrder: 'asc' } });
    if (sections.length >= MAX_SECTIONS) throw new BadRequestException(`A policy can have at most ${MAX_SECTIONS} sections.`);
    let sortOrder = (sections[sections.length - 1]?.sortOrder || 0) + 10;
    if (dto.afterSectionId) {
      const idx = sections.findIndex((s) => s.id === dto.afterSectionId);
      if (idx >= 0) {
        // Re-space everything so there's a gap right after the anchor.
        await this.prisma.$transaction(sections.map((s, i) => this.prisma.legalPolicySection.update({ where: { id: s.id }, data: { sortOrder: (i + 1) * 10 + (i > idx ? 10 : 0) } })));
        sortOrder = (idx + 1) * 10 + 5;
      }
    }
    const created = await this.prisma.legalPolicySection.create({
      data: {
        versionId: v.id, title, slug: uniqueSlug(title, new Set(sections.map((s) => s.slug))),
        content: sanitizeHtml(dto.content || ''), sortOrder, isActive: dto.isActive ?? true,
      },
    });
    await this.audit(actor, 'LEGAL_SECTION_ADDED', v.policyId, { versionId: v.id, sectionId: created.id, title });
    return created;
  }

  async updateSection(sectionId: string, dto: SectionDto, actor: Actor) {
    const s = await this.sectionInDraft(sectionId);
    const data: any = {};
    if (dto.title !== undefined) {
      data.title = sanitizeText(dto.title, 160);
      if (!data.title) throw new BadRequestException('Section title is required');
    }
    if (dto.content !== undefined) data.content = sanitizeHtml(dto.content);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const updated = await this.prisma.legalPolicySection.update({ where: { id: s.id }, data });
    await this.audit(actor, dto.isActive !== undefined && Object.keys(data).length === 1
      ? (dto.isActive ? 'LEGAL_SECTION_ENABLED' : 'LEGAL_SECTION_DISABLED')
      : 'LEGAL_SECTION_UPDATED', s.version.policyId, { versionId: s.versionId, sectionId: s.id, title: updated.title });
    return updated;
  }

  async deleteSection(sectionId: string, actor: Actor) {
    const s = await this.sectionInDraft(sectionId);
    await this.prisma.legalPolicySection.delete({ where: { id: s.id } });
    await this.audit(actor, 'LEGAL_SECTION_DELETED', s.version.policyId, { versionId: s.versionId, sectionId: s.id, title: s.title });
    return { deleted: true };
  }

  async duplicateSection(sectionId: string, actor: Actor) {
    const s = await this.sectionInDraft(sectionId);
    return this.addSection(s.versionId, { title: `${s.title} (copy)`.slice(0, 160), content: s.content, isActive: s.isActive, afterSectionId: s.id }, actor);
  }

  async reorder(versionId: string, dto: ReorderDto, actor: Actor) {
    const v = await this.draftOrThrow(versionId);
    const sections = await this.prisma.legalPolicySection.findMany({ where: { versionId: v.id }, select: { id: true } });
    const ids = new Set(sections.map((s) => s.id));
    if (dto.sectionIds.length !== ids.size || new Set(dto.sectionIds).size !== ids.size || !dto.sectionIds.every((id) => ids.has(id))) {
      throw new BadRequestException('sectionIds must list every section of this version exactly once.');
    }
    await this.prisma.$transaction(dto.sectionIds.map((id, i) => this.prisma.legalPolicySection.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })));
    await this.audit(actor, 'LEGAL_SECTIONS_REORDERED', v.policyId, { versionId: v.id });
    return this.getVersion(v.id);
  }

  // ── Status transitions ──
  async publish(policyId: string, dto: PublishDto, actor: Actor) {
    const policy = await this.findPolicy(policyId);
    if (policy.status === LegalPolicyStatus.ARCHIVED) throw new BadRequestException('Restore the policy from the archive before publishing it.');
    const draft = await this.prisma.legalPolicyVersion.findFirst({
      where: { policyId: policy.id, status: EDITABLE },
      include: { sections: { where: { isActive: true } } },
    });

    if (!draft) {
      // Re-publish the last published version of an unpublished policy.
      if (policy.status === LegalPolicyStatus.UNPUBLISHED && policy.currentVersionId) {
        const updated = await this.prisma.legalPolicy.update({ where: { id: policy.id }, data: { status: LegalPolicyStatus.PUBLISHED } });
        await this.audit(actor, 'LEGAL_POLICY_REPUBLISHED', policy.id, { versionId: policy.currentVersionId, version: policy.currentVersion });
        return { published: true, policy: updated, version: policy.currentVersion };
      }
      throw new BadRequestException('There is no draft to publish.');
    }
    if (!draft.sections.length) throw new BadRequestException('Cannot publish a policy with no active sections.');

    const values = await this.variableValues();
    const unresolved = findUnresolved(draft.sections.map((s) => s.content).join('\n'), withComputed(values));
    // Missing critical business facts (legal name, address, grievance officer, …) block
    // publishing outright; optional gaps and [[placeholders]] only need confirmation.
    const missingCritical = unresolved.missingVariables.filter((v) => CRITICAL_VARIABLES.includes(v));
    if (missingCritical.length) {
      throw new BadRequestException(
        `Complete Settings → Legal Information before publishing. Missing: ${missingCritical.map((v) => LEGAL_VARIABLE_SETTINGS[v].label).join(', ')}.`,
      );
    }
    if ((unresolved.placeholders.length || unresolved.missingVariables.length) && !dto.force) {
      return { published: false, requiresConfirmation: true, ...unresolved };
    }

    const all = await this.prisma.legalPolicyVersion.findMany({ where: { policyId: policy.id }, select: { major: true } });
    const label = draft.major === 0
      ? { major: Math.max(0, ...all.map((v) => v.major)) + 1, minor: 0 }
      : { major: draft.major, minor: draft.minor };
    const versionLabel = `${label.major}.${label.minor}`;
    const now = new Date();
    const actorName = await this.actorName(actor);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.legalPolicyVersion.updateMany({
        where: { policyId: policy.id, status: LegalPolicyVersionStatus.PUBLISHED, id: { not: draft.id } },
        data: { status: LegalPolicyVersionStatus.ARCHIVED, archivedAt: now },
      });
      await tx.legalPolicyVersion.update({
        where: { id: draft.id },
        data: {
          version: versionLabel, major: label.major, minor: label.minor,
          status: LegalPolicyVersionStatus.PUBLISHED, publishedAt: now, publishedById: actor.sub, publishedByName: actorName,
          effectiveDate: draft.effectiveDate || now,
          ...(dto.changeNote ? { changeNote: sanitizeText(dto.changeNote, 500) } : {}),
        },
      });
      return tx.legalPolicy.update({
        where: { id: policy.id },
        data: {
          status: LegalPolicyStatus.PUBLISHED, currentVersionId: draft.id, currentVersion: versionLabel,
          publishedAt: now, publishedById: actor.sub, publishedByName: actorName, effectiveDate: draft.effectiveDate || now,
        },
      });
    });
    await this.audit(actor, 'LEGAL_POLICY_PUBLISHED', policy.id, {
      versionId: draft.id, version: versionLabel, previousVersion: policy.currentVersion,
      forcedWithUnresolved: dto.force ? unresolved : undefined,
    });
    return { published: true, policy: updated, version: versionLabel };
  }

  async unpublish(policyId: string, actor: Actor) {
    const policy = await this.findPolicy(policyId);
    if (policy.status !== LegalPolicyStatus.PUBLISHED) throw new BadRequestException('Only a published policy can be unpublished.');
    const updated = await this.prisma.legalPolicy.update({ where: { id: policy.id }, data: { status: LegalPolicyStatus.UNPUBLISHED } });
    await this.audit(actor, 'LEGAL_POLICY_UNPUBLISHED', policy.id, { version: policy.currentVersion });
    return updated;
  }

  async archive(policyId: string, actor: Actor) {
    const policy = await this.findPolicy(policyId);
    if (policy.status === LegalPolicyStatus.ARCHIVED) return policy;
    const updated = await this.prisma.legalPolicy.update({ where: { id: policy.id }, data: { status: LegalPolicyStatus.ARCHIVED } });
    await this.audit(actor, 'LEGAL_POLICY_ARCHIVED', policy.id, { previousStatus: policy.status });
    return updated;
  }

  async unarchive(policyId: string, actor: Actor) {
    const policy = await this.findPolicy(policyId);
    if (policy.status !== LegalPolicyStatus.ARCHIVED) throw new BadRequestException('Policy is not archived.');
    const status = policy.currentVersionId ? LegalPolicyStatus.UNPUBLISHED : LegalPolicyStatus.DRAFT;
    const updated = await this.prisma.legalPolicy.update({ where: { id: policy.id }, data: { status } });
    await this.audit(actor, 'LEGAL_POLICY_UNARCHIVED', policy.id, { status });
    return updated;
  }

  // ── Audit / acceptances ──
  async auditTrail(policyId: string) {
    const policy = await this.findPolicy(policyId);
    return this.prisma.auditLog.findMany({
      where: { targetType: LEGAL_AUDIT_TARGET, targetId: policy.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { name: true, role: true } } },
    });
  }

  async acceptances(policyId: string, limit = 100) {
    const policy = await this.findPolicy(policyId);
    const [rows, byVersion] = await Promise.all([
      this.prisma.policyAcceptance.findMany({ where: { policyId: policy.id }, orderBy: { acceptedAt: 'desc' }, take: Math.min(limit, 500) }),
      this.prisma.policyAcceptance.groupBy({ by: ['version'], where: { policyId: policy.id }, _count: { _all: true } }),
    ]);
    return { rows, byVersion: byVersion.map((b) => ({ version: b.version, count: b._count._all })) };
  }

  // ── Legal information (variables) ──
  async variableValues(): Promise<Record<string, string>> {
    const keys = Object.values(LEGAL_VARIABLE_SETTINGS).map((d) => d.key);
    const rows = await this.prisma.siteSetting.findMany({ where: { key: { in: [...keys, 'support_email', 'support_phone'] } } });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const values: Record<string, string> = {};
    for (const [name, def] of Object.entries(LEGAL_VARIABLE_SETTINGS)) values[name] = (byKey[def.key] || '').trim();
    // Fall back to Website Settings → Contact so support details are maintained in one place.
    values.SUPPORT_EMAIL ||= (byKey.support_email || '').trim();
    values.SUPPORT_PHONE ||= (byKey.support_phone || '').trim();
    return values;
  }

  async getLegalInfo() {
    const values = await this.variableValues();
    return Object.entries(LEGAL_VARIABLE_SETTINGS).map(([name, def]) => ({ name, key: def.key, label: def.label, value: values[name] || '' }));
  }

  async setLegalInfo(dto: LegalInfoDto, actor: Actor) {
    const changed: string[] = [];
    for (const [name, raw] of Object.entries(dto.values || {})) {
      const def = LEGAL_VARIABLE_SETTINGS[name];
      if (!def || typeof raw !== 'string') continue;
      const value = sanitizeText(raw, 500);
      await this.prisma.siteSetting.upsert({
        where: { key: def.key },
        create: { key: def.key, value, label: def.label, group: 'legal' },
        update: { value },
      });
      changed.push(name);
    }
    await logAudit(this.prisma, { actorId: actor.sub, actorRole: actor.role, action: 'LEGAL_INFO_UPDATED', targetType: 'LegalInformation', metadata: { changed } });
    return this.getLegalInfo();
  }

  // ── Rendering ──
  renderVersion(policy: any, version: any, values: Record<string, string>) {
    const lastUpdated = version.publishedAt || version.updatedAt || policy.updatedAt;
    const vars = {
      ...values,
      CURRENT_DATE: formatPolicyDate(new Date()),
      LAST_UPDATED: formatPolicyDate(lastUpdated),
      POLICY_VERSION: version.version,
    };
    const missing = new Set<string>();
    const sections = (version.sections || [])
      .filter((s: any) => s.isActive)
      .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
      .map((s: any) => {
        const r = renderVariables(sanitizeHtml(s.content), vars);
        r.missing.forEach((m) => missing.add(m));
        return { id: s.slug, title: s.title, html: r.html };
      });
    const website = (values.WEBSITE_URL || DEFAULT_WEBSITE).replace(/\/+$/, '');
    return {
      title: policy.title,
      slug: policy.slug,
      publicPath: policy.publicPath,
      category: policy.category,
      version: version.version,
      status: version.status,
      effectiveDate: version.effectiveDate || policy.effectiveDate,
      lastUpdated,
      lastUpdatedLabel: formatPolicyDate(lastUpdated),
      seoTitle: policy.seoTitle || `${policy.title} | ${values.COMPANY_NAME || 'Remont India'}`,
      seoDescription: policy.seoDescription || policy.description || '',
      canonical: website + policy.publicPath,
      sections,
      missingVariables: [...missing],
    };
  }

  async preview(versionId: string) {
    const version = await this.getVersion(versionId);
    const policy = await this.prisma.legalPolicy.findUnique({ where: { id: version.policyId } });
    const values = await this.variableValues();
    const rendered = this.renderVersion(policy, version, values);
    const unresolved = findUnresolved(version.sections.filter((s) => s.isActive).map((s) => s.content).join('\n'), withComputed(values));
    return { ...rendered, placeholders: unresolved.placeholders };
  }

  // ── Public ──
  async publicList() {
    const rows = await this.prisma.legalPolicy.findMany({
      where: { status: LegalPolicyStatus.PUBLISHED, currentVersionId: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { title: true, slug: true, publicPath: true, category: true, currentVersion: true, publishedAt: true, showInFooter: true },
    });
    return rows.map(({ currentVersion, ...r }) => ({ ...r, version: currentVersion }));
  }

  async publicPolicy(key: string) {
    const k = String(key || '').toLowerCase();
    if (!SLUG_RE.test(k)) throw new NotFoundException('Policy not found');
    const policy = await this.prisma.legalPolicy.findFirst({
      where: { OR: [{ slug: k }, { publicPath: `/${k}` }, { publicPath: `/policy/${k}` }] },
    });
    if (!policy || policy.status !== LegalPolicyStatus.PUBLISHED || !policy.currentVersionId) throw new NotFoundException('Policy not found');
    const version = await this.getVersion(policy.currentVersionId);
    if (version.status !== LegalPolicyVersionStatus.PUBLISHED) throw new NotFoundException('Policy not found');
    const { missingVariables, status, ...rendered } = this.renderVersion(policy, version, await this.variableValues());
    return rendered;
  }

  async accept(dto: AcceptDto, user: Actor, ip?: string, userAgent?: string) {
    const policy = await this.prisma.legalPolicy.findFirst({
      where: { OR: [{ slug: dto.policy }, { publicPath: `/${dto.policy}` }] },
    });
    if (!policy || policy.status !== LegalPolicyStatus.PUBLISHED || !policy.currentVersionId) throw new NotFoundException('Policy not found');
    if (dto.versionId && dto.versionId !== policy.currentVersionId) {
      throw new ConflictException('This policy has been updated since you opened it — please review the latest version.');
    }
    const existing = await this.prisma.policyAcceptance.findFirst({ where: { policyId: policy.id, versionId: policy.currentVersionId, userId: user.sub } });
    if (existing) return existing;
    return this.prisma.policyAcceptance.create({
      data: {
        policyId: policy.id, versionId: policy.currentVersionId, version: policy.currentVersion || '',
        userId: user.sub, subjectType: user.role === UserRole.CUSTOMER ? 'CUSTOMER' : 'USER', subjectId: user.sub,
        ip: ip?.slice(0, 64) || null, userAgent: userAgent?.slice(0, 300) || null,
      },
    });
  }

  myAcceptances(userId: string) {
    return this.prisma.policyAcceptance.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'desc' },
      include: { policy: { select: { title: true, slug: true, publicPath: true, currentVersion: true } } },
    });
  }

  // ── helpers ──
  private async actorName(actor: Actor) {
    if (actor.name) return actor.name;
    const u = await this.prisma.user.findUnique({ where: { id: actor.sub }, select: { name: true } }).catch(() => null);
    return u?.name || null;
  }

  private audit(actor: Actor, action: string, policyId: string, metadata: Record<string, unknown>) {
    return logAudit(this.prisma, { actorId: actor.sub, actorRole: actor.role, action, targetType: LEGAL_AUDIT_TARGET, targetId: policyId, metadata });
  }
}

/** Computed variables always resolve at render time, so they never count as "missing". */
function withComputed(values: Record<string, string>): Record<string, string> {
  return { ...values, CURRENT_DATE: '-', LAST_UPDATED: '-', POLICY_VERSION: '-' };
}

function uniqueSlug(title: string, used: Set<string>): string {
  const base = slugify(title) || 'section';
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

// ─── Controllers ───────────────────────────────────────────────────────────
@ApiTags('Admin — Legal & Policies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/legal')
export class AdminLegalController {
  constructor(private legal: LegalService) {}

  @Get('policies') list(@Query() q: ListQuery) { return this.legal.list(q); }
  @Post('policies') create(@Body() dto: CreatePolicyDto, @CurrentUser() u: JwtPayload) { return this.legal.create(dto, u); }
  @Post('policies/ensure-defaults') ensureDefaults() { return this.legal.ensureDefaultPolicies().then((created) => ({ created })); }
  @Get('policies/:id') get(@Param('id') id: string) { return this.legal.getPolicy(id); }
  @Patch('policies/:id') update(@Param('id') id: string, @Body() dto: UpdatePolicyDto, @CurrentUser() u: JwtPayload) { return this.legal.update(id, dto, u); }
  @Post('policies/:id/draft') draft(@Param('id') id: string, @CurrentUser() u: JwtPayload) { return this.legal.ensureDraft(id, u); }
  @Post('policies/:id/publish') publish(@Param('id') id: string, @Body() dto: PublishDto, @CurrentUser() u: JwtPayload) { return this.legal.publish(id, dto, u); }
  @Post('policies/:id/unpublish') unpublish(@Param('id') id: string, @CurrentUser() u: JwtPayload) { return this.legal.unpublish(id, u); }
  @Post('policies/:id/archive') archive(@Param('id') id: string, @CurrentUser() u: JwtPayload) { return this.legal.archive(id, u); }
  @Post('policies/:id/unarchive') unarchive(@Param('id') id: string, @CurrentUser() u: JwtPayload) { return this.legal.unarchive(id, u); }
  @Get('policies/:id/audit') audit(@Param('id') id: string) { return this.legal.auditTrail(id); }
  @Get('policies/:id/acceptances') acceptances(@Param('id') id: string, @Query('limit') limit?: string) { return this.legal.acceptances(id, limit ? +limit : 100); }

  @Get('versions/:versionId') version(@Param('versionId') id: string) { return this.legal.getVersion(id); }
  @Get('versions/:versionId/preview') preview(@Param('versionId') id: string) { return this.legal.preview(id); }
  @Patch('versions/:versionId') updateVersion(@Param('versionId') id: string, @Body() dto: UpdateVersionDto, @CurrentUser() u: JwtPayload) { return this.legal.updateVersion(id, dto, u); }
  @Post('versions/:versionId/discard') discard(@Param('versionId') id: string, @CurrentUser() u: JwtPayload) { return this.legal.discardDraft(id, u); }
  @Post('versions/:versionId/restore') restore(@Param('versionId') id: string, @Body() dto: RestoreDto, @CurrentUser() u: JwtPayload) { return this.legal.restore(id, dto, u); }
  @Post('versions/:versionId/sections') addSection(@Param('versionId') id: string, @Body() dto: SectionDto, @CurrentUser() u: JwtPayload) { return this.legal.addSection(id, dto, u); }
  @Post('versions/:versionId/reorder') reorder(@Param('versionId') id: string, @Body() dto: ReorderDto, @CurrentUser() u: JwtPayload) { return this.legal.reorder(id, dto, u); }

  @Patch('sections/:sectionId') updateSection(@Param('sectionId') id: string, @Body() dto: SectionDto, @CurrentUser() u: JwtPayload) { return this.legal.updateSection(id, dto, u); }
  @Delete('sections/:sectionId') deleteSection(@Param('sectionId') id: string, @CurrentUser() u: JwtPayload) { return this.legal.deleteSection(id, u); }
  @Post('sections/:sectionId/duplicate') duplicate(@Param('sectionId') id: string, @CurrentUser() u: JwtPayload) { return this.legal.duplicateSection(id, u); }

  @Get('legal-info') legalInfo() { return this.legal.getLegalInfo(); }
  @Put('legal-info') setLegalInfo(@Body() dto: LegalInfoDto, @CurrentUser() u: JwtPayload) { return this.legal.setLegalInfo(dto, u); }
}

@ApiTags('Legal & Policies')
@Controller('legal')
export class LegalController {
  constructor(private legal: LegalService) {}

  @Public() @Get('policies') list() { return this.legal.publicList(); }
  @Public() @Get('policies/:key') get(@Param('key') key: string) { return this.legal.publicPolicy(key); }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('accept')
  accept(@Body() dto: AcceptDto, @CurrentUser() u: JwtPayload, @Req() req: any) {
    return this.legal.accept(dto, u, req.ip, req.headers?.['user-agent']);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Get('acceptances/me')
  mine(@CurrentUser('sub') userId: string) { return this.legal.myAcceptances(userId); }
}

@Module({
  controllers: [AdminLegalController, LegalController],
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
