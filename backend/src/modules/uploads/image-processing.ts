import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import sharp from 'sharp';

// Low-level image primitives shared by the central media pipeline
// (backend/src/modules/media/media.service.ts) — sharp optimization and the Cloudinary
// delivery upload. Split out of uploads.module.ts (which re-exports everything here, so
// existing imports keep working) so the media module can use them without a circular
// import back into the uploads controller file.
//
// Accepts either a single CLOUDINARY_URL (cloudinary://key:secret@cloud-name — what's
// actually set on Railway) or the three separate CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY
// / CLOUDINARY_API_SECRET vars (see .env.example). The Cloudinary SDK auto-parses
// CLOUDINARY_URL the first time cloudinary.config() is touched (by any call, including the
// one inside uploader.upload_stream) — so the three-var form is only explicitly applied here
// when actually present. IMPORTANT: never call cloudinary.config({cloud_name: undefined, ...})
// unconditionally — lodash's extend() (which the SDK uses internally) overwrites
// already-set values with `undefined`, which would silently wipe out a working CLOUDINARY_URL
// config. The secret never leaves the backend: it's only used here, server-side, to sign the
// upload request.
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

/**
 * The already-configured Cloudinary credentials (from CLOUDINARY_URL or the three separate
 * vars), for the REST APIs the SDK doesn't wrap — currently the Image Generation add-on.
 * Server-side only; these values never leave the backend.
 */
export function cloudinaryCredentials(): { cloudName: string; apiKey: string; apiSecret: string } {
  assertCloudinaryConfigured();
  const cfg = cloudinary.config();
  return { cloudName: cfg.cloud_name!, apiKey: cfg.api_key!, apiSecret: cfg.api_secret! };
}

export function assertCloudinaryConfigured(): void {
  const cfg = cloudinary.config();
  if (!cfg.cloud_name || !cfg.api_key || !cfg.api_secret) {
    throw new InternalServerErrorException('Image/video upload is not configured (set CLOUDINARY_URL, or CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)');
  }
}

// ─── Server-side image optimization ──────────────────────────────────────────
// Runs AFTER authentication, content validation and the ClamAV scan, and BEFORE anything
// reaches permanent storage — so the bytes that become the permanent asset are the optimized
// ones. The original upload only ever exists as an in-memory buffer for the life of the
// request: it is never written to disk and never stored, so there is no temporary original
// to clean up afterwards.

/** Largest image accepted at the route boundary (Multer rejects anything bigger with 413). */
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Longest-side cap for the stored master. Smaller images keep their own dimensions. */
export const IMAGE_MAX_DIMENSION = 2000;

/** WebP quality — the usual "visually indistinguishable at normal viewing size" point for
 *  photographic content, while cutting file size dramatically. */
export const IMAGE_WEBP_QUALITY = 82;

/** Decompression-bomb guard: refuse to decode beyond this pixel count at all, so a crafted
 *  file declaring enormous dimensions fails fast instead of exhausting server memory. */
export const MAX_DECODE_PIXELS = 40_000_000;

/** Formats converted to WebP. GIF is included, but only single-frame GIFs — an ANIMATED GIF
 *  is rejected outright rather than converted, because a still-WebP conversion would
 *  silently destroy the animation. Nothing in the product accepts animated GIFs: no upload
 *  control offers them (the explicit accept lists are image/jpeg,image/png[,image/webp]) and
 *  nothing reads them, so rejecting is the honest outcome rather than storing an
 *  un-optimized original that would violate the "stored asset is always optimized" policy. */
const CONVERTIBLE_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif']);

export interface OptimizedImage {
  buffer: Buffer;
  format: string;
  width: number;
  height: number;
  originalBytes: number;
  optimizedBytes: number;
}

/**
 * Decode -> auto-orient -> downscale -> strip metadata -> re-encode as WebP.
 *
 * Transparency survives: WebP has a native alpha channel and sharp carries a PNG's alpha
 * through, so a transparent PNG stays transparent instead of gaining a black/white matte.
 *
 * Always returns an optimized image or throws — it never hands back the original bytes, so
 * the asset that reaches permanent storage is guaranteed to be the optimized one.
 */
export async function optimizeImage(input: Buffer): Promise<OptimizedImage> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_DECODE_PIXELS }).metadata();
  } catch {
    throw new BadRequestException('Image could not be decoded for optimization');
  }
  const format = (meta.format || '').toLowerCase();
  if (!CONVERTIBLE_FORMATS.has(format)) {
    throw new BadRequestException('This image format is not supported for upload.');
  }
  // `pages` is the frame count; > 1 means an animated GIF. Converting it to WebP here would
  // keep only the first frame, so reject instead of silently destroying the animation.
  if (format === 'gif' && (meta.pages ?? 1) > 1) {
    throw new BadRequestException('Animated GIFs are not supported — please upload a JPG, PNG or WebP image.');
  }

  const { data, info } = await sharp(input, {
    limitInputPixels: MAX_DECODE_PIXELS,
    sequentialRead: true, // decode in a streaming fashion rather than materializing the full raster up front
  })
    // .rotate() with no argument applies the EXIF orientation and drops the tag. It must run
    // BEFORE metadata is stripped, or a phone photo would end up stored sideways.
    .rotate()
    .resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',            // preserves aspect ratio
      withoutEnlargement: true, // never upscales a smaller image
    })
    // sharp drops EXIF/GPS/camera metadata unless withMetadata() is called — so NOT calling
    // it is what strips location and device data from the stored asset.
    .webp({ quality: IMAGE_WEBP_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    format: info.format,
    width: info.width,
    height: info.height,
    originalBytes: input.length,
    optimizedBytes: data.length,
  };
}

export interface UploadBufferOptions {
  /** Full Cloudinary public_id (folders included). Server-generated only — never user input.
   *  When omitted, Cloudinary assigns a random id under the `remont` folder, as before. */
  publicId?: string;
}

// `preOptimized` is set by the media pipeline, which has already resized and re-encoded the
// bytes with sharp — Cloudinary must then NOT re-transform on the way in, since that would
// decode and re-encode a second time for no benefit. Callers passing raw bytes keep the
// incoming dimension cap, so an oversized original is still never stored at full resolution.
//
// `eager` (images only) pre-generates and caches the three named delivery variants at upload
// time rather than on each one's first request, all f_auto,q_auto — so a browser that
// supports AVIF is served AVIF derived from the WebP master, without AVIF being the stored
// format (which keeps delivery compatible with the existing Cloudinary pipeline).
export function uploadBuffer(buffer: Buffer, resourceType: 'image' | 'video', preOptimized = false, opts: UploadBufferOptions = {}): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const options: Record<string, any> = { resource_type: resourceType };
    if (opts.publicId) {
      options.public_id = opts.publicId;
      options.overwrite = false; // a server-generated UUID key must never replace an existing asset
    } else {
      options.folder = 'remont';
    }
    if (resourceType === 'image') {
      if (!preOptimized) options.transformation = [{ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, crop: 'limit' }];
      options.eager = [
        { width: 200, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
        { width: 600, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
        { width: 1200, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
      ];
      options.eager_async = false; // the response needs all three variant URLs synchronously
    } else {
      options.transformation = [{ quality: 'auto' }];
    }
    const stream = cloudinary.uploader.upload_stream(
      options,
      (err, result) => (err || !result) ? reject(err || new Error('Cloudinary upload failed')) : resolve(result),
    );
    stream.end(buffer);
  });
}

/** Removes an asset from Cloudinary (cleanup after a failed upload, or a media deletion). */
export async function destroyCloudinaryAsset(publicId: string, resourceType: 'image' | 'video' = 'image'): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
}

// Fallback only — used if Cloudinary's eager array ever comes back short (should not happen
// in normal operation). f_auto,q_auto to match the eager variants, not the old
// f_webp,q_auto:good.
export function cloudinaryResize(secureUrl: string, width: number): string {
  return secureUrl.replace('/upload/', `/upload/w_${width},c_limit,f_auto,q_auto/`);
}

export interface DeliveryVariants { thumb: string; card: string; full: string }

/** The three named delivery sizes (200/600/1200) for an uploaded image. */
export function deliveryVariantsFrom(result: UploadApiResponse): DeliveryVariants {
  const eager = result.eager || [];
  return {
    thumb: eager[0]?.secure_url || cloudinaryResize(result.secure_url, 200),
    card: eager[1]?.secure_url || cloudinaryResize(result.secure_url, 600),
    full: eager[2]?.secure_url || cloudinaryResize(result.secure_url, 1200),
  };
}
