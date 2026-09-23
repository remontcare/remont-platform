import { Module, Injectable, Controller, Post, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Body, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';
import { MediaEntityType, UserRole } from '@prisma/client';
import { UploadSecurityInterceptor } from './upload-security.interceptor';
import { assertCloudinaryConfigured, uploadBuffer, MAX_IMAGE_UPLOAD_BYTES } from './image-processing';
import { MediaModule } from '../media/media.module';
import { MediaService, toLegacyUploadResponse } from '../media/media.service';
import { defaultEntityTypeFor, parseEntityType, requestIp, MEDIA_UPLOAD_THROTTLE } from '../media/media.policy';

// Task 3 — one-click image/video upload, stored on Cloudinary (not local disk). Local disk
// on Railway is ephemeral and gets wiped on every redeploy, which is why previously-uploaded
// category logos kept turning into broken images. main.ts's express.static for /api/uploads
// is left in place only so any already-issued old /api/uploads/* links keep resolving.
//
// IMAGES now go through the central media pipeline (backend/src/modules/media): security
// validation -> ClamAV -> sharp -> R2 master -> Cloudinary delivery -> Media record. These
// two routes are kept, with their original {thumb, card, full, url, publicId} response
// shape, because every existing admin/seller/customer page already calls them — they are
// thin adapters onto MediaService.ingestImage(), not a second pipeline.

// The image primitives used to live in this file; re-exported so existing imports
// (ai-enrichment, specs) keep resolving unchanged.
export * from './image-processing';

@Injectable()
export class UploadsService {
  // Task 8 — promo video upload for categories/sub-categories/services. Videos are not part
  // of the image media pipeline yet (no sharp step); they keep this direct Cloudinary path
  // behind UploadSecurityInterceptor's signature check + ClamAV scan.
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
  constructor(private uploads: UploadsService, private media: MediaService) {}

  // @Roles is per-route here (not controller-level) specifically so lead-photo below can
  // have no role requirement at all — RolesGuard reads @Roles via getAllAndOverride
  // (handler, then class), so a controller-level @Roles would still apply to every route,
  // including a @Public() one, and then throw ("User not authenticated") since @Public()
  // only skips JwtAuthGuard, never RolesGuard.
  // PRODUCT_VENDOR included so sellers can upload real product images as hosted URLs.
  // Phase 6 — CUSTOMER included so a customer can attach evidence photos (damaged/wrong
  // product, warranty claim) to a support/return/warranty case.
  // No UploadSecurityInterceptor on the image routes: MediaService.ingestImage() runs the
  // same signature/MIME/dimension/ClamAV checks itself as the first stages of the pipeline,
  // so every caller (including server-side ones like AI generation) gets them exactly once.
  // Optional multipart field `entityType` (e.g. PRODUCT, SERVICE, BANNER) files the upload
  // under the right Media Library folder; it is checked against the caller's role.
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.PRODUCT_VENDOR, UserRole.CUSTOMER)
  @Throttle(MEDIA_UPLOAD_THROTTLE)
  @Post('image')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1 }, // 20MB input ceiling — what gets STORED is the much smaller optimized WebP, not this
  }))
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
    @Body('entityType') entityType: string | undefined,
    @Req() req: any,
  ) {
    const media = await this.media.ingestImage({
      buffer: file?.buffer,
      declaredMimeType: file?.mimetype,
      originalName: file?.originalname,
      entityType: parseEntityType(entityType) ?? defaultEntityTypeFor(user.role),
      actor: { id: user.sub, role: user.role },
      ip: requestIp(req),
    });
    return toLegacyUploadResponse(media);
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
  // see uploads.module.spec.ts), so ANY authenticated user can attach a reference photo to
  // a quotation request (frontend/index.html submitQuotation()).
  @Throttle(MEDIA_UPLOAD_THROTTLE)
  @Post('lead-photo')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1 }, // same 20MB policy as /uploads/image — the stored asset is the optimized WebP either way
  }))
  async uploadLeadPhoto(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload, @Req() req: any) {
    const media = await this.media.ingestImage({
      buffer: file?.buffer,
      declaredMimeType: file?.mimetype,
      originalName: file?.originalname,
      entityType: MediaEntityType.LEAD,
      actor: { id: user.sub, role: user.role },
      ip: requestIp(req),
    });
    return toLegacyUploadResponse(media);
  }
}

@Module({
  imports: [MediaModule],
  controllers: [UploadsController],
  providers: [UploadsService, UploadSecurityInterceptor],
})
export class UploadsModule {}
