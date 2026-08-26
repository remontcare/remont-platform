import { Module, Injectable, Controller, Post, UseGuards, UseInterceptors, UploadedFile, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { JwtAuthGuard, RolesGuard, Roles, Public } from '../../common';
import { UserRole } from '@prisma/client';

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

function assertCloudinaryConfigured(): void {
  const cfg = cloudinary.config();
  if (!cfg.cloud_name || !cfg.api_key || !cfg.api_secret) {
    throw new InternalServerErrorException('Image/video upload is not configured (set CLOUDINARY_URL, or CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)');
  }
}

function uploadBuffer(buffer: Buffer, resourceType: 'image' | 'video'): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'remont', resource_type: resourceType },
      (err, result) => (err || !result) ? reject(err || new Error('Cloudinary upload failed')) : resolve(result),
    );
    stream.end(buffer);
  });
}

// Cloudinary serves resized/re-encoded variants on the fly by inserting a transformation
// segment into the delivery URL — no need to pre-generate and store separate files per size.
function cloudinaryResize(secureUrl: string, width: number): string {
  return secureUrl.replace('/upload/', `/upload/w_${width},c_limit,f_webp,q_auto:good/`);
}

@Injectable()
export class UploadsService {
  async processAndStore(file: Express.Multer.File): Promise<{ thumb: string; card: string; full: string; url: string; publicId: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('image/')) throw new BadRequestException('File must be an image');
    assertCloudinaryConfigured();

    const result = await uploadBuffer(file.buffer, 'image');
    return {
      thumb: cloudinaryResize(result.secure_url, 200),
      card: cloudinaryResize(result.secure_url, 600),
      full: cloudinaryResize(result.secure_url, 1200),
      url: cloudinaryResize(result.secure_url, 1200),
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

  // @Roles is per-route here (not controller-level) specifically so the public
  // lead-photo route below can have no role requirement at all — RolesGuard reads
  // @Roles via getAllAndOverride(handler, then class), so a controller-level @Roles
  // would still apply to every route including ones marked @Public(), and then throw
  // ("User not authenticated") since @Public() only skips JwtAuthGuard, never RolesGuard.
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('image')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — generous for a single photo, matches the existing 5MB client-side check with headroom
  }))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.processAndStore(file);
  }

  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('video')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — generous for a short promo clip
  }))
  uploadVideo(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.storeVideo(file);
  }

  // Public — the only unauthenticated route on this controller (@Public() overrides the
  // controller-level admin guard for this one route, same pattern already used for
  // POST /crm/leads/capture). Lets a customer attach a reference photo to a quotation
  // request (Renovation/Construction premium lead forms) without an account. Reuses the
  // exact same processAndStore() pipeline as the admin image upload — same WebP/size
  // limits, same Cloudinary storage — just reachable without a JWT. A smaller size cap
  // than the admin route (5MB, matching the client-side check the lead forms already do)
  // plus the app-wide rate limiter (ThrottlerModule, 200 req/min) are the abuse guards.
  @Public()
  @Post('lead-photo')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  }))
  uploadLeadPhoto(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.processAndStore(file);
  }
}

@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
