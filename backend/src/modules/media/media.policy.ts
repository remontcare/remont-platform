import { BadRequestException } from '@nestjs/common';
import { MediaEntityType, MediaSource, UserRole } from '@prisma/client';

// Pure, dependency-free policy for the central media pipeline: which roles may upload which
// kind of media, where it is stored, and the legacy-compatibility guards. Kept separate from
// MediaService so it can be unit-tested and reused by callers without DI.

/** Image formats accepted by the pipeline — detected from the file BYTES, never from the
 *  extension or the client-declared Content-Type. Each maps to the MIME types a client may
 *  legitimately declare for it; a declared type outside the list is a mismatch. */
export const ALLOWED_IMAGE_FORMATS: Record<string, string[]> = {
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  gif: ['image/gif'], // single-frame only — optimizeImage() rejects animated GIFs
};

/** Longest side accepted before decoding, and the pixel-count ceiling (decompression-bomb
 *  guard). Real phone photos are ~12-50MP at most; 25MP matches the existing
 *  UploadSecurityInterceptor ceiling so no currently-accepted upload is newly rejected. */
export const MAX_IMAGE_SIDE = 12_000;
export const MAX_IMAGE_MEGAPIXELS = 25;

/** Per-route upload rate limit (on top of the global 200/min per-IP throttler). */
export const MEDIA_UPLOAD_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

/** Storage folder per entity type. The complete object key is always server-generated from
 *  this map + a UUID — a client can never choose (or traverse out of) a storage path. */
export const ENTITY_FOLDER: Record<MediaEntityType, string> = {
  PRODUCT: 'products',
  SELLER_PROFILE: 'sellers',
  SERVICE: 'services',
  CATEGORY: 'categories',
  SUBCATEGORY: 'categories',
  BRAND: 'brands',
  BANNER: 'banners',
  MARKETING: 'marketing',
  PROJECT: 'projects',
  BLOG: 'blogs',
  CMS: 'cms',
  PARTNER_PROFILE: 'partners',
  CUSTOMER_UPLOAD: 'customers',
  LEAD: 'leads',
  GENERAL: 'general',
};

const ALL_ENTITY_TYPES = Object.values(MediaEntityType) as MediaEntityType[];

/** Which entity types each role may upload. Admins may upload anything; everyone else only
 *  what belongs to them. LEAD is open to every authenticated user (quotation photos). */
export const ROLE_ENTITY_TYPES: Record<UserRole, MediaEntityType[]> = {
  ADMIN: ALL_ENTITY_TYPES,
  SUPER_ADMIN: ALL_ENTITY_TYPES,
  PRODUCT_VENDOR: [MediaEntityType.PRODUCT, MediaEntityType.SELLER_PROFILE, MediaEntityType.LEAD],
  SERVICE_VENDOR: [MediaEntityType.PARTNER_PROFILE, MediaEntityType.PROJECT, MediaEntityType.LEAD],
  CUSTOMER: [MediaEntityType.CUSTOMER_UPLOAD, MediaEntityType.LEAD],
  DELIVERY_PARTNER: [MediaEntityType.LEAD],
  CORPORATE_USER: [MediaEntityType.LEAD],
  CRM_AGENT: [MediaEntityType.LEAD],
};

export function isAdminRole(role: UserRole | undefined): boolean {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
}

export function canUploadEntityType(role: UserRole, entityType: MediaEntityType): boolean {
  return (ROLE_ENTITY_TYPES[role] || []).includes(entityType);
}

/** Entity type used when a legacy caller (/uploads/image) does not name one. */
export function defaultEntityTypeFor(role: UserRole): MediaEntityType {
  if (role === UserRole.PRODUCT_VENDOR) return MediaEntityType.PRODUCT;
  if (role === UserRole.CUSTOMER) return MediaEntityType.CUSTOMER_UPLOAD;
  if (role === UserRole.SERVICE_VENDOR) return MediaEntityType.PARTNER_PROFILE;
  if (isAdminRole(role)) return MediaEntityType.GENERAL;
  return MediaEntityType.LEAD;
}

/** Parses a client-supplied entity type. undefined/empty -> undefined; anything not in the
 *  enum is a 400 (never silently coerced). */
export function parseEntityType(raw: unknown): MediaEntityType | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim().toUpperCase();
  if (!(ALL_ENTITY_TYPES as string[]).includes(value)) throw new BadRequestException('Invalid media entity type');
  return value as MediaEntityType;
}

/** Entity ids are cuids/uuids — anything else is refused rather than stored. */
export function parseEntityId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new BadRequestException('Invalid entity id');
  return value;
}

/**
 * The Cloudinary public_id (= Media.storageKey): remont/<folder>/<uuid>, with product images
 * split into remont/products/original/ (uploaded) and remont/products/generated/ (AI).
 * Every segment is server-controlled — no client input ever reaches the path.
 */
export function buildStorageKey(entityType: MediaEntityType, id: string, source: MediaSource = MediaSource.UPLOAD): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Storage key id must be a UUID');
  const sub = entityType === MediaEntityType.PRODUCT ? (source === MediaSource.AI_GENERATED ? '/generated' : '/original') : '';
  return `remont/${ENTITY_FOLDER[entityType]}${sub}/${id}`;
}

/** Original filename is kept only as display metadata: path components and control
 *  characters stripped, length capped. It is never used to build a storage path. */
export function sanitizeOriginalName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 200);
  return cleaned || null;
}

export function isInlineImage(value: unknown): boolean {
  return typeof value === 'string' && /^\s*data:/i.test(value);
}

function flattenStrings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...flattenStrings(v));
    else if (typeof v === 'string') out.push(v);
  }
  return out;
}

export function containsInlineImage(...values: unknown[]): boolean {
  return flattenStrings(values).some(isInlineImage);
}

/**
 * New base64/data: URI images are no longer accepted into any image column — they must go
 * through the media pipeline and be referenced by URL. A data: URI that is ALREADY stored on
 * the record (legacy rows, left untouched until the separate migration task) is allowed to
 * pass through an update unchanged, so editing an old product never fails.
 */
export function assertNoNewInlineImages(incoming: unknown, existing?: unknown): void {
  const fresh = flattenStrings([incoming]).filter(isInlineImage);
  if (!fresh.length) return;
  const kept = new Set(flattenStrings([existing]).filter(isInlineImage));
  if (fresh.some((v) => !kept.has(v))) {
    throw new BadRequestException('Embedded (base64) images are no longer accepted. Upload the image first and use the returned URL.');
  }
}

/** Distinct, non-inline URL strings from any mix of strings / string arrays, in order. */
export function collectImageUrls(...values: unknown[]): string[] {
  const seen = new Set<string>();
  for (const v of flattenStrings(values)) {
    const url = v.trim();
    if (url && !isInlineImage(url) && !seen.has(url)) seen.add(url);
  }
  return [...seen];
}

export function requestIp(req: any): string | undefined {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req?.ip;
}
