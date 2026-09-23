import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule, PrismaService } from '../../prisma/prisma.module';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';
import { UploadsModule, UploadsController } from '../uploads/uploads.module';
import { ProductsModule, ProductsService } from '../products/products.module';
import { AiEnrichmentModule, AiEnrichmentService } from '../ai-enrichment/ai-enrichment.module';
import { AdminModule, AdminService } from '../admin/admin.module';
import { VendorsModule, ServiceVendorsService } from '../vendors/vendors.module';
import { OrdersModule, OrdersService } from '../orders/orders.module';
import { AdminController } from '../admin/admin.module';
import { AiImageService } from '../ai-images/ai-image.service';

// Dependency-injection wiring: every module that stores or links images must receive the ONE
// shared MediaService (not an undefined @Optional one). Compiles the real module graph with a
// stub Prisma — no database connection, no lifecycle hooks.
describe('media module wiring', () => {
  it('uploads, products, AI, admin, partner profile and job-completion all get the same MediaService instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot(),
        PrismaModule, MediaModule, UploadsModule, ProductsModule, AiEnrichmentModule, AdminModule, VendorsModule, OrdersModule,
      ],
    }).overrideProvider(PrismaService).useValue({}).compile();

    const media = moduleRef.get(MediaService);
    expect(media).toBeInstanceOf(MediaService);
    expect((moduleRef.get(UploadsController) as any).media).toBe(media);
    expect((moduleRef.get(ProductsService) as any).media).toBe(media);
    expect((moduleRef.get(AiEnrichmentService) as any).media).toBe(media);
    expect((moduleRef.get(AdminService) as any).media).toBe(media);
    expect((moduleRef.get(ServiceVendorsService) as any).media).toBe(media);
    expect((moduleRef.get(OrdersService) as any).media).toBe(media);
    // The admin AI image generator stores through the same MediaService, and is wired into
    // the existing (admin-only) AdminController rather than a controller of its own.
    const aiImages = moduleRef.get(AiImageService);
    expect((aiImages as any).media).toBe(media);
    expect((moduleRef.get(AdminController) as any).aiImages).toBe(aiImages);
  }, 60000);
});
