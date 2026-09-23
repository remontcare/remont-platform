import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException,
  Logger, NotFoundException, PayloadTooLargeException, ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import {
  Media, MediaEntityType, MediaSource, MediaStatus, MediaStorageProvider, MediaType, Prisma, UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { logAudit } from '../../common';
import {
  detectFileSignature, scanForMalware, SCAN_INCONCLUSIVE_REASON, SCAN_UNAVAILABLE_REASON,
} from '../uploads/upload-security.interceptor';
import {
  assertCloudinaryConfigured, deliveryVariantsFrom, destroyCloudinaryAsset, optimizeImage, uploadBuffer,
  MAX_DECODE_PIXELS, MAX_IMAGE_UPLOAD_BYTES,
} from '../uploads/image-processing';
import {
  ALLOWED_IMAGE_FORMATS, MAX_IMAGE_MEGAPIXELS, MAX_IMAGE_SIDE, buildStorageKey, canUploadEntityType, collectImageUrls,
  isAdminRole, sanitizeOriginalName,
} from './media.policy';

// ═══════════════════════════════════════════════════════════════════════════
// CENTRAL MEDIA SERVICE — the ONE image upload pipeline for the whole platform.
//
//   caller (seller / admin / customer / AI / future mobile)
//     -> size limit -> role policy -> magic-byte signature -> declared-MIME agreement
//     -> decode + dimension/pixel limits -> ClamAV (fail-closed)
//     -> sharp re-encode (orient, cap 2000px, WebP, EXIF/GPS stripped)
//     -> Cloudinary (the single source of truth + CDN delivery, eager thumb/card/full)
//     -> Media row (READY)
//
// CLOUDINARY IS THE ONLY ACTIVE STORAGE PROVIDER. The file never touches PostgreSQL, the
// local filesystem or any other store — the Media row holds only the reference (public_id,
// delivery URLs). Media.storageProvider/storageKey keep the design open to another provider
// later without changing callers.
//
// Nothing is stored anywhere until every check has passed. If the Cloudinary stage fails,
// any partial asset is destroyed and the PROCESSING row is removed — no broken record, no
// base64 or local-disk fallback. A process crash mid-upload leaves at most a stale
// PROCESSING row, which sweepStaleUploads() cleans up together with its asset.
// ═══════════════════════════════════════════════════════════════════════════

export interface MediaActor {
  id?: string; // absent only for internal admin-side calls (linking), never for uploads
  role: UserRole;
}

export interface IngestImageInput {
  buffer: Buffer | undefined;
  /** Client-declared Content-Type. When present it must agree with the detected format. */
  declaredMimeType?: string;
  originalName?: string;
  entityType: MediaEntityType;
  entityId?: string | null;
  source?: MediaSource;
  actor: MediaActor & { id: string };
  ip?: string;
}

export interface PublicMedia {
  id: string;
  type: MediaType;
  url: string | null;
  deliveryUrl: string | null;
  storageKey: string;
  storageProvider: MediaStorageProvider;
  cloudinaryPublicId: string | null;
  width: number | null;
  height: number | null;
  size: number;
  mimeType: string;
  status: MediaStatus;
  entityType: MediaEntityType;
  entityId: string | null;
  isPrimary: boolean;
  sortOrder: number;
  source: MediaSource;
  variants: { thumb?: string; card?: string; full?: string } | null;
  originalName: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

/** Stable API shape — never includes credentials or internal checksums/paths beyond the key. */
export function toPublicMedia(m: Media): PublicMedia {
  return {
    id: m.id,
    type: m.mediaType,
    url: m.deliveryUrl,
    deliveryUrl: m.deliveryUrl,
    storageKey: m.storageKey,
    storageProvider: m.storageProvider,
    cloudinaryPublicId: m.cloudinaryPublicId,
    width: m.width,
    height: m.height,
    size: m.size,
    mimeType: m.mimeType,
    status: m.status,
    entityType: m.entityType,
    entityId: m.entityId,
    isPrimary: m.isPrimary,
    sortOrder: m.sortOrder,
    source: m.source,
    variants: (m.variants as any) || null,
    originalName: m.originalName,
    uploadedBy: m.uploadedBy,
    createdAt: m.createdAt,
  };
}

/** The response shape /uploads/image has always returned ({thumb, card, full, url, publicId}),
 *  plus the new media id — so every existing frontend caller keeps working unchanged. */
export function toLegacyUploadResponse(m: PublicMedia) {
  return {
    thumb: m.variants?.thumb ?? m.deliveryUrl,
    card: m.variants?.card ?? m.deliveryUrl,
    full: m.variants?.full ?? m.deliveryUrl,
    url: m.deliveryUrl,
    publicId: m.cloudinaryPublicId ?? m.storageKey,
    mediaId: m.id,
  };
}

const GENERIC_SECURITY_REJECTION = 'File rejected by security validation.';
const GENERIC_STORAGE_FAILURE = 'The image could not be stored. Please try again.';
const STALE_PROCESSING_MS = 30 * 60 * 1000;

export interface MediaListQuery {
  q?: string;
  entityType?: MediaEntityType;
  entityId?: string;
  mediaType?: MediaType;
  status?: MediaStatus;
  source?: MediaSource;
  uploadedBy?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private prisma: PrismaService) {}

  // ─── Ingest ────────────────────────────────────────────────────────────────

  async ingestImage(input: IngestImageInput): Promise<PublicMedia> {
    const { buffer, actor, entityType } = input;
    const source = input.source ?? MediaSource.UPLOAD;
    const originalName = sanitizeOriginalName(input.originalName);
    const ctx = { actor, ip: input.ip, entityType, source, originalName, size: buffer?.length ?? 0 };
    this.logger.log(`Media upload attempt: user=${actor.id} role=${actor.role} entityType=${entityType} source=${source} bytes=${ctx.size}`);

    // 1. Presence + size — before any decoding work.
    if (!buffer || !buffer.length) throw new BadRequestException('No file uploaded');
    if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
      await this.audit(ctx, 'MEDIA_REJECTED_OVERSIZED', { limit: MAX_IMAGE_UPLOAD_BYTES });
      throw new PayloadTooLargeException(`Image exceeds the maximum upload size of ${MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024)}MB.`);
    }

    // 2. Role policy — may this role upload this kind of media at all?
    if (!canUploadEntityType(actor.role, entityType)) {
      await this.audit(ctx, 'MEDIA_REJECTED_NOT_PERMITTED');
      throw new ForbiddenException('You are not allowed to upload this type of media.');
    }

    // 3. Real file signature (magic bytes). Extension and Content-Type are never trusted.
    const sig = detectFileSignature(buffer);
    if (sig.kind !== 'image' || !sig.format || !ALLOWED_IMAGE_FORMATS[sig.format]) {
      await this.audit(ctx, 'MEDIA_REJECTED_INVALID_TYPE', { detectedKind: sig.kind, detectedFormat: sig.format, dangerLabel: sig.dangerLabel });
      throw new BadRequestException('Only JPEG, PNG, WebP or GIF images are allowed.');
    }

    // 4. Declared MIME must agree with the detected format.
    if (input.declaredMimeType !== undefined) {
      const declared = String(input.declaredMimeType || '').toLowerCase().split(';')[0].trim();
      if (!ALLOWED_IMAGE_FORMATS[sig.format].includes(declared)) {
        await this.audit(ctx, 'MEDIA_REJECTED_MIME_MISMATCH', { declared, detected: sig.format });
        throw new BadRequestException("The file's content does not match its declared type.");
      }
    }

    // 5. Decode the header: the decoder must agree with the signature (processing
    //    capability), and dimensions/pixel count must be sane (decompression-bomb guard).
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(buffer, { limitInputPixels: MAX_DECODE_PIXELS }).metadata();
    } catch {
      await this.audit(ctx, 'MEDIA_REJECTED_UNDECODABLE', { detected: sig.format });
      throw new BadRequestException('File could not be read as a valid image.');
    }
    const decodedFormat = (meta.format || '').toLowerCase();
    if (decodedFormat !== sig.format) {
      await this.audit(ctx, 'MEDIA_REJECTED_MIME_MISMATCH', { detected: sig.format, decoded: decodedFormat });
      throw new BadRequestException("The file's content does not match its declared type.");
    }
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || (width * height) / 1_000_000 > MAX_IMAGE_MEGAPIXELS) {
      await this.audit(ctx, 'MEDIA_REJECTED_DIMENSIONS', { width, height });
      throw new BadRequestException(`Image dimensions are not allowed (max ${MAX_IMAGE_SIDE}px per side, ${MAX_IMAGE_MEGAPIXELS} megapixels).`);
    }

    // 6. Malware scan — fail-closed. The file has only ever existed in memory so far.
    const scan = await scanForMalware(buffer, originalName || 'upload', this.logger);
    if (!scan.clean) {
      const unavailable = scan.reason === SCAN_UNAVAILABLE_REASON || scan.reason === SCAN_INCONCLUSIVE_REASON;
      await this.audit(ctx, unavailable ? 'MEDIA_REJECTED_SCAN_UNAVAILABLE' : 'MEDIA_REJECTED_MALWARE', { reason: scan.reason });
      if (unavailable) throw new ServiceUnavailableException('Uploads are temporarily unavailable. Please try again shortly.');
      throw new BadRequestException(GENERIC_SECURITY_REJECTION);
    }

    // 7. Re-encode — the stored master is always the sanitized WebP, never the original bytes.
    let optimized: Awaited<ReturnType<typeof optimizeImage>>;
    try {
      optimized = await optimizeImage(buffer);
    } catch (e: any) {
      await this.audit(ctx, 'MEDIA_REJECTED_PROCESSING', { reason: e?.message });
      if (e instanceof HttpException) throw e;
      throw new BadRequestException('The image could not be processed.');
    }

    // 8. Storage prerequisites — Cloudinary is the only storage provider.
    assertCloudinaryConfigured();

    const id = randomUUID();
    const storageKey = buildStorageKey(entityType, id, source); // = the Cloudinary public_id
    const checksum = createHash('sha256').update(optimized.buffer).digest('hex');

    await this.prisma.media.create({
      data: {
        id,
        storageProvider: MediaStorageProvider.CLOUDINARY,
        storageKey,
        originalName,
        originalFormat: sig.format,
        originalSize: buffer.length,
        mimeType: 'image/webp',
        extension: 'webp',
        size: optimized.optimizedBytes,
        width: optimized.width,
        height: optimized.height,
        checksum,
        mediaType: MediaType.IMAGE,
        source,
        entityType,
        entityId: input.entityId ?? null,
        status: MediaStatus.PROCESSING,
        uploadedBy: actor.id,
      },
    });

    // 9. Permanent storage — Cloudinary, under the server-generated public_id. All-or-nothing.
    try {
      const result = await uploadBuffer(optimized.buffer, 'image', true, { publicId: storageKey });
      const cloudinaryPublicId = result.public_id;
      const variants = deliveryVariantsFrom(result);
      const ready = await this.prisma.media.update({
        where: { id },
        data: {
          status: MediaStatus.READY,
          cloudinaryPublicId,
          deliveryUrl: result.secure_url,
          variants: variants as unknown as Prisma.InputJsonValue,
          variantUrls: collectImageUrls(result.secure_url, variants.thumb, variants.card, variants.full),
        },
      });
      await this.audit({ ...ctx, mediaId: id }, 'MEDIA_UPLOAD_ACCEPTED', {
        storageProvider: MediaStorageProvider.CLOUDINARY, publicId: cloudinaryPublicId, storedBytes: optimized.optimizedBytes, width: optimized.width, height: optimized.height,
      });
      return toPublicMedia(ready);
    } catch (e: any) {
      this.logger.error(`Media ${id} Cloudinary storage failed: ${e?.message}`);
      // Destroy by the known public_id even when the upload call itself errored — a timed-out
      // upload can still have created the asset on Cloudinary's side.
      await this.cleanupStorage(id, storageKey);
      await this.prisma.media.delete({ where: { id } }).catch((err) => this.logger.error(`Failed to remove PROCESSING media row ${id}: ${err?.message}`));
      await this.audit({ ...ctx, mediaId: id }, 'MEDIA_PROCESSING_FAILED', { reason: e?.message });
      throw new InternalServerErrorException(GENERIC_STORAGE_FAILURE);
    }
  }

  // ─── Linking (backward compatibility with URL columns) ────────────────────

  /**
   * Links READY media to the record that now uses them, by matching the URLs saved in that
   * record's legacy image columns (Product.images, Service.imageUrl, …) against each Media
   * row's delivery URLs. Order in `urls` becomes sortOrder; the first is primary. Media this
   * entity previously held that are no longer referenced are detached (not deleted).
   *
   * Pass the record's COMPLETE current set of image URLs. Non-admins can only link media they
   * uploaded themselves, of the same entity type, not already attached elsewhere.
   * Best-effort by design: a linking failure is logged and never fails the entity save.
   */
  async linkByUrls(params: { entityType: MediaEntityType; entityId: string; urls: unknown; actor: MediaActor }): Promise<number> {
    const { entityType, entityId, actor } = params;
    try {
      const urls = collectImageUrls(params.urls);
      const admin = isAdminRole(actor.role);
      const candidates = urls.length
        ? await this.prisma.media.findMany({ where: { status: MediaStatus.READY, variantUrls: { hasSome: urls } } })
        : [];

      const linked: string[] = [];
      for (const m of candidates) {
        if (!admin && m.uploadedBy !== actor.id) continue;
        const typeOk = m.entityType === entityType || (admin && m.entityType === MediaEntityType.GENERAL);
        if (!typeOk) continue;
        if (m.entityId && !(m.entityId === entityId && m.entityType === entityType)) continue; // attached elsewhere — never steal
        const position = urls.findIndex((u) => m.variantUrls.includes(u));
        await this.prisma.media.update({
          where: { id: m.id },
          data: { entityType, entityId, sortOrder: position, isPrimary: position === 0 },
        });
        linked.push(m.id);
      }

      await this.prisma.media.updateMany({
        where: { entityType, entityId, status: MediaStatus.READY, id: { notIn: linked } },
        data: { entityId: null, isPrimary: false },
      });
      return linked.length;
    } catch (e: any) {
      this.logger.warn(`Media linking failed for ${entityType} ${entityId}: ${e?.message}`);
      return 0;
    }
  }

  // ─── Media Library ────────────────────────────────────────────────────────

  async list(query: MediaListQuery) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const where: Prisma.MediaWhereInput = {
      ...(query.status ? { status: query.status } : { status: { not: MediaStatus.DELETED } }),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.mediaType ? { mediaType: query.mediaType } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.uploadedBy ? { uploadedBy: query.uploadedBy } : {}),
      ...(query.from || query.to ? {
        createdAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      } : {}),
      ...(query.q ? {
        OR: [
          { originalName: { contains: query.q, mode: 'insensitive' } },
          { storageKey: { contains: query.q, mode: 'insensitive' } },
          { id: query.q },
        ],
      } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.media.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { uploader: { select: { id: true, name: true, role: true } } },
      }),
      this.prisma.media.count({ where }),
    ]);
    return {
      items: items.map((m) => ({ ...toPublicMedia(m), uploader: m.uploader })),
      total, page, limit,
    };
  }

  async get(id: string, actor: MediaActor): Promise<PublicMedia> {
    return toPublicMedia(await this.findAccessible(id, actor));
  }

  /** Owners may reorder / set primary; only admins may re-file media to another entity. */
  async update(id: string, actor: MediaActor, body: { isPrimary?: boolean; sortOrder?: number; entityType?: MediaEntityType; entityId?: string | null }) {
    const m = await this.findAccessible(id, actor);
    if (m.status !== MediaStatus.READY) throw new ConflictException('Only ready media can be updated');
    const admin = isAdminRole(actor.role);
    if (!admin && (body.entityType !== undefined || body.entityId !== undefined)) {
      throw new ForbiddenException('Only admins can move media between records');
    }
    const data: Prisma.MediaUpdateInput = {};
    if (body.sortOrder !== undefined) {
      const n = Number(body.sortOrder);
      if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new BadRequestException('Invalid sortOrder');
      data.sortOrder = n;
    }
    if (body.entityType !== undefined) data.entityType = body.entityType;
    if (body.entityId !== undefined) data.entityId = body.entityId;
    if (body.isPrimary !== undefined) data.isPrimary = !!body.isPrimary;

    const targetType = body.entityType ?? m.entityType;
    const targetId = body.entityId !== undefined ? body.entityId : m.entityId;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (data.isPrimary === true && targetId) {
        await tx.media.updateMany({ where: { entityType: targetType, entityId: targetId, id: { not: id } }, data: { isPrimary: false } });
      }
      return tx.media.update({ where: { id }, data });
    });
    return toPublicMedia(updated);
  }

  /**
   * Soft-deletes the row (kept for audit) and removes the stored objects. Refused while the
   * media is still attached to a record, since that record's URL column would then point at a
   * deleted asset — detach it (remove it from the record) first.
   */
  async remove(id: string, actor: MediaActor & { id: string }, ip?: string) {
    const m = await this.findAccessible(id, actor);
    if (m.status === MediaStatus.DELETED) return toPublicMedia(m);
    if (m.entityId) throw new ConflictException('This media is still used by a record. Remove it from that record first.');

    const deleted = await this.prisma.media.update({
      where: { id },
      data: { status: MediaStatus.DELETED, deletedAt: new Date(), isPrimary: false },
    });
    await this.cleanupStorage(id, m.cloudinaryPublicId ?? m.storageKey);
    await this.audit({ actor, ip, entityType: m.entityType, source: m.source, originalName: m.originalName, size: m.size, mediaId: id }, 'MEDIA_DELETED');
    return toPublicMedia(deleted);
  }

  // ─── Stale upload sweep ───────────────────────────────────────────────────

  /** A PROCESSING row older than 30 minutes means the process died mid-upload. Remove any
   *  Cloudinary asset it may have written (its public_id is the storageKey), then the row. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepStaleUploads(now = new Date()): Promise<number> {
    const stale = await this.prisma.media.findMany({
      where: { status: MediaStatus.PROCESSING, createdAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
      take: 100,
    });
    for (const m of stale) {
      await this.cleanupStorage(m.id, m.cloudinaryPublicId ?? m.storageKey);
      await this.prisma.media.delete({ where: { id: m.id } }).catch(() => undefined);
    }
    if (stale.length) this.logger.warn(`Swept ${stale.length} stale PROCESSING media upload(s)`);
    return stale.length;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async findAccessible(id: string, actor: MediaActor): Promise<Media> {
    const m = await this.prisma.media.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Media not found');
    if (!isAdminRole(actor.role) && m.uploadedBy !== actor.id) throw new NotFoundException('Media not found');
    return m;
  }

  /** Best-effort removal of a Cloudinary asset. Never throws — failures are logged for follow-up. */
  private async cleanupStorage(mediaId: string, publicId: string) {
    await destroyCloudinaryAsset(publicId).catch((e) => this.logger.error(`Orphan cleanup: Cloudinary destroy failed for media ${mediaId}: ${e?.message}`));
  }

  /**
   * Same pipeline for callers whose existing API contract carries the image as a data: URI
   * (partner app profile photo, job-completion photos). The URI is decoded in memory and put
   * through ingestImage() — only the resulting Cloudinary URL is ever persisted, never the
   * base64 itself.
   */
  async ingestDataUrl(dataUrl: unknown, input: Omit<IngestImageInput, 'buffer' | 'declaredMimeType'>): Promise<PublicMedia> {
    const match = typeof dataUrl === 'string' ? /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim()) : null;
    if (!match) throw new BadRequestException('Image must be a base64 data URL');
    // Reject by encoded length before decoding anything (base64 is 4 chars per 3 bytes).
    if (Math.floor((match[2].length * 3) / 4) > MAX_IMAGE_UPLOAD_BYTES + 3) {
      throw new PayloadTooLargeException(`Image exceeds the maximum upload size of ${MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024)}MB.`);
    }
    return this.ingestImage({ ...input, buffer: Buffer.from(match[2], 'base64'), declaredMimeType: match[1] });
  }

  /** Security audit trail. Never throws, never records file contents or secrets. */
  private async audit(
    ctx: { actor: MediaActor; ip?: string; entityType: MediaEntityType; source: MediaSource; originalName: string | null; size: number; mediaId?: string },
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    const level = action.startsWith('MEDIA_REJECTED') || action === 'MEDIA_PROCESSING_FAILED' ? 'warn' : 'log';
    this.logger[level](`${action} user=${ctx.actor.id} entityType=${ctx.entityType} media=${ctx.mediaId ?? '-'}`);
    if (!ctx.actor.id) return;
    try {
      await logAudit(this.prisma, {
        actorId: ctx.actor.id,
        actorRole: ctx.actor.role,
        action,
        targetType: 'MEDIA',
        targetId: ctx.mediaId,
        metadata: { entityType: ctx.entityType, source: ctx.source, filename: ctx.originalName, size: ctx.size, ...extra },
        ip: ctx.ip,
      });
    } catch (e: any) {
      this.logger.error(`Failed to write media audit log: ${e?.message}`);
    }
  }
}
