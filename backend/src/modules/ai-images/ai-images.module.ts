import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AiImageService } from './ai-image.service';

// Admin-facing AI image generation. No controller of its own: the routes live on the
// existing AdminController (backend/src/modules/admin), which already carries the
// ADMIN/SUPER_ADMIN authorization every other admin endpoint uses.
@Module({
  imports: [MediaModule],
  providers: [AiImageService],
  exports: [AiImageService],
})
export class AiImagesModule {}
