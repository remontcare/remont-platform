import { Module, Injectable, Controller, Post, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common';
import { UserRole } from '@prisma/client';

// Task 3 — one-click image upload: converts to WebP and generates thumbnail/card/full
// responsive sizes server-side (sharp), so the admin never has to think about format or
// size, and the front-end can pick the right size per breakpoint with real lazy-loading
// instead of one giant inline base64 blob (the previous client-side-only compressImage()
// pipeline in admin/common.js, which is left untouched — this is an additive alternative,
// not a replacement, so nothing that already relies on it breaks).
//
// Files are written to a local `uploads/` directory and served back at /api/uploads/<name>
// — that path is deliberately under /api/ so it rides the *existing* Vercel rewrite
// (frontend/vercel.json proxies /api/:path* to the Railway backend) with zero new frontend
// routing/CDN config. NOTE: this is local disk storage — Railway's filesystem is ephemeral
// across redeploys, so uploaded images will not survive a deploy. Fine to ship today; swap
// for persistent storage (Railway Volume or S3/Cloudinary) before relying on this long-term.
const SIZES: { name: 'thumb' | 'card' | 'full'; width: number }[] = [
  { name: 'thumb', width: 200 },
  { name: 'card', width: 600 },
  { name: 'full', width: 1200 },
];

@Injectable()
export class UploadsService {
  private readonly uploadDir = path.join(process.cwd(), 'uploads');

  async processAndStore(file: Express.Multer.File): Promise<{ thumb: string; card: string; full: string; url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('image/')) throw new BadRequestException('File must be an image');

    await fs.mkdir(this.uploadDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const urls: Record<string, string> = {};

    for (const s of SIZES) {
      const filename = `${id}-${s.name}.webp`;
      await sharp(file.buffer)
        .resize({ width: s.width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path.join(this.uploadDir, filename));
      urls[s.name] = `/api/uploads/${filename}`;
    }

    return { thumb: urls.thumb, card: urls.card, full: urls.full, url: urls.full };
  }

  // Task 8 — promo video upload for categories/sub-categories/services. Sharp's resize
  // pipeline only makes sense for images, so video just gets written to disk as-is
  // (same ephemeral-storage caveat as processAndStore above).
  async storeVideo(file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('video/')) throw new BadRequestException('File must be a video');

    await fs.mkdir(this.uploadDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname) || '.mp4';
    const filename = `${id}-video${ext}`;
    await fs.writeFile(path.join(this.uploadDir, filename), file.buffer);
    return { url: `/api/uploads/${filename}` };
  }
}

@ApiTags('Uploads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('uploads')
export class UploadsController {
  constructor(private uploads: UploadsService) {}

  @Post('image')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — generous for a single photo, matches the existing 5MB client-side check with headroom
  }))
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.processAndStore(file);
  }

  @Post('video')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — generous for a short promo clip
  }))
  uploadVideo(@UploadedFile() file: Express.Multer.File) {
    return this.uploads.storeVideo(file);
  }
}

@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
