import { Module, Injectable, Controller, Post, UseGuards, UseInterceptors, UploadedFile, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
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

// Exported so other modules (e.g. ai-enrichment.module.ts, which fetches AI-found/generated
// images as raw bytes, not multipart form uploads) can reuse the same Cloudinary pipeline
// instead of duplicating it.
//
// Web-optimized delivery, whatever the input size — a 20MB DSLR photo or a 50MB phone
// panorama must never sit around at full size:
//  - `transformation` is the MAIN upload transformation, applied before Cloudinary stores
//    anything — this caps what's actually STORED (the "master"), not just what's served on
//    delivery. Images: capped at 2000px on the longest side (w_2000,h_2000,c_limit only
//    scales down when a dimension exceeds it, so it never upscales a smaller original).
//    Video: quality:'auto' so the stored master itself isn't full-bitrate raw (kept to this
//    minimum rather than a streaming_profile HLS transcode, which needs a Cloudinary
//    add-on that may not be enabled on every plan and could otherwise break uploads).
//  - `eager` (images only) pre-generates and caches the three named delivery variants at
//    upload time — not on each one's first delivery request — every one f_auto,q_auto
//    (auto format + auto quality, i.e. WebP/AVIF served automatically per-browser) rather
//    than the previous hardcoded f_webp,q_auto:good.
export function uploadBuffer(buffer: Buffer, resourceType: 'image' | 'video'): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const options: Record<string, any> = { folder: 'remont', resource_type: resourceType };
    if (resourceType === 'image') {
      options.transformation = [{ width: 2000, height: 2000, crop: 'limit' }];
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

    const result = await uploadBuffer(file.buffer, 'image');
    const eager = result.eager || [];
    return {
      thumb: eager[0]?.secure_url || cloudinaryResize(result.secure_url, 200),
      card: eager[1]?.secure_url || cloudinaryResize(result.secure_url, 600),
      full: eager[2]?.secure_url || cloudinaryResize(result.secure_url, 1200),
      // The 2000px-capped master (the `transformation` above already applied it on upload —
      // this is never the raw, unbounded-resolution original).
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
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — generous for a single photo, matches the existing 5MB client-side check with headroom
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
    limits: { fileSize: 5 * 1024 * 1024 },
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
