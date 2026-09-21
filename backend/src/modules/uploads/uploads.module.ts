import { Module, Injectable, Controller, Post, UseGuards, UseInterceptors, UploadedFile, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import sharp from 'sharp';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common';
import { UserRole } from '@prisma/client';
import { UploadSecurityInterceptor } from './upload-security.interceptor';

// Task 3 — one-click image/video upload, stored on Cloudinary (not local disk). Category,
// sub-category, service and product images/videos all flow through this one module, so this
// is the single choke point that needed fixing: local disk on Railway is ephemeral and gets
// wiped on every redeploy, which is why previously-uploaded category logos kept turning into
// broken images. Cloudinary URLs are permanent, so nothing here needs the /api/uploads
// static-file route or Vercel rewrite trick anymore (main.ts's express.static for
// /api/uploads is left in place only so any already-issued old /api/uploads/* links keep
// resolving locally until they naturally get replaced).
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

export function assertCloudinaryConfigured(): void {
  const cfg = cloudinary.config();
  if (!cfg.cloud_name || !cfg.api_key || !cfg.api_secret) {
    throw new InternalServerErrorException('Image/video upload is not configured (set CLOUDINARY_URL, or CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)');
  }
}

// ─── Server-side image optimization ──────────────────────────────────────────
// Runs AFTER authentication, content validation and the ClamAV scan, and BEFORE anything
// reaches Cloudinary — so the bytes that become the permanent asset are the optimized ones.
// The original upload only ever exists as the in-memory Multer buffer for the life of the
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

// Exported so other modules (e.g. ai-enrichment.module.ts, which fetches AI-found/generated
// images as raw bytes, not multipart form uploads) can reuse the same Cloudinary pipeline
// instead of duplicating it.
//
// `preOptimized` is set by processAndStore(), which has already resized and re-encoded the
// bytes with sharp — Cloudinary must then NOT re-transform on the way in, since that would
// decode and re-encode a second time for no benefit. Callers passing raw bytes
// (ai-enrichment, animated GIFs) keep the incoming dimension cap, so an oversized original
// is still never stored at full resolution.
//
// `eager` (images only) pre-generates and caches the three named delivery variants at upload
// time rather than on each one's first request, all f_auto,q_auto — so a browser that
// supports AVIF is served AVIF derived from the WebP master, without AVIF being the stored
// format (which keeps delivery compatible with the existing Cloudinary pipeline).
export function uploadBuffer(buffer: Buffer, resourceType: 'image' | 'video', preOptimized = false): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const options: Record<string, any> = { folder: 'remont', resource_type: resourceType };
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

// Fallback only — used if Cloudinary's eager array ever comes back short (should not happen
// in normal operation). f_auto,q_auto to match the eager variants, not the old
// f_webp,q_auto:good.
function cloudinaryResize(secureUrl: string, width: number): string {
  return secureUrl.replace('/upload/', `/upload/w_${width},c_limit,f_auto,q_auto/`);
}

@Injectable()
export class UploadsService {
  async processAndStore(file: Express.Multer.File): Promise<{ thumb: string; card: string; full: string; url: string; publicId: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('image/')) throw new BadRequestException('File must be an image');
    assertCloudinaryConfigured();

    // Optimize first — the bytes Cloudinary stores permanently are the optimized ones. The
    // original buffer becomes garbage as soon as this method returns: never written to disk,
    // never uploaded, so nothing temporary is left behind to clean up.
    const optimized = await optimizeImage(file.buffer);
    const result = await uploadBuffer(optimized.buffer, 'image', true);
    const eager = result.eager || [];
    return {
      thumb: eager[0]?.secure_url || cloudinaryResize(result.secure_url, 200),
      card: eager[1]?.secure_url || cloudinaryResize(result.secure_url, 600),
      full: eager[2]?.secure_url || cloudinaryResize(result.secure_url, 1200),
      // The optimized WebP master produced above — never the raw full-size original, which
      // is discarded when this request ends.
      url: result.secure_url,
      publicId: result.public_id,
    };
  }

  // Task 8 — promo video upload for categories/sub-categories/services.
  async storeVideo(file: Express.Multer.File): Promise<{ url: string; publicId: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('video/')) throw new BadRequestException('File must be a video');
    assertCloudinaryConfigured();

    const result = await uploadBuffer(file.buffer, 'video');
    return { url: result.secure_url, publicId: result.public_id };
  }
}

@ApiTags('Uploads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private uploads: UploadsService) {}

  // @Roles is per-route here (not controller-level) specifically so lead-photo below can
  // have no role requirement at all — RolesGuard reads @Roles via getAllAndOverride
  // (handler, then class), so a controller-level @Roles would still apply to every route,
  // including a @Public() one, and then throw ("User not authenticated") since @Public()
  // only skips JwtAuthGuard, never RolesGuard.
  // PRODUCT_VENDOR included so sellers can upload real product images (incl. ones
  // found/generated via the paid ai-enrichment flow) as hosted Cloudinary URLs instead of
  // only the pre-existing client-side base64 fallback in seller.html.
  // Phase 6 — CUSTOMER included so a customer can attach evidence photos (damaged/wrong
  // product, warranty claim) to a support/return/warranty case. The handler has no admin-only
  // side effect (returns Cloudinary URLs only), so this is a safe, minimal widening.
  // UploadSecurityInterceptor MUST come after FileInterceptor in this list — it reads
  // req.file, which only exists once FileInterceptor has parsed the multipart body. One
  // shared implementation covers content-type validation, dangerous-signature blocking, the
  // image megapixel ceiling, and malware scanning identically for all three routes; see
  // upload-security.interceptor.ts — nothing route-specific is duplicated here.
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.PRODUCT_VENDOR, UserRole.CUSTOMER)
  @Post('image')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES }, // 20MB input ceiling — what gets STORED is the much smaller optimized WebP, not this
  }), UploadSecurityInterceptor)
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.processAndStore(file);
  }

  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('video')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — generous for a short promo clip
  }), UploadSecurityInterceptor)
  uploadVideo(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.storeVideo(file);
  }

  // SECURITY — this route used to be @Public() (no login required at all), so anyone could
  // upload arbitrary files to Cloudinary through the lead-capture form with zero
  // authentication. It now requires the same OTP-issued JwtAuthGuard as the other two
  // routes; no @Roles() restriction is declared (RolesGuard no-ops when no roles are set —
  // see uploads.module.spec.ts), so ANY authenticated user — customer, vendor, or admin, not
  // one specific role — can attach a reference photo to a quotation request. The frontend
  // lead-capture flow (frontend/index.html submitQuotation()) only prompts for a quick
  // phone+OTP login when a photo is actually attached (openAuthModal(), same pattern as
  // subscribeAmc()) — submitting the quote request itself stays fully anonymous.
  @Post('lead-photo')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES }, // same 20MB policy as /uploads/image — the stored asset is the optimized WebP either way
  }), UploadSecurityInterceptor)
  uploadLeadPhoto(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.processAndStore(file);
  }
}

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, UploadSecurityInterceptor],
})
export class UploadsModule {}
