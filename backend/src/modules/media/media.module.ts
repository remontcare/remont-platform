import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

// Central media storage — see media.service.ts for the pipeline. Imported by every module
// that stores or links images (uploads, products, admin, ai-enrichment); none of them
// store media any other way.
@Module({
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
