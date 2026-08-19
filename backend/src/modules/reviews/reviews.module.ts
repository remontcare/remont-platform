import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards,
  NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsArray, Max, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload, Public } from '../../common';

// ─── DTOs ───

class CreateReviewDto {
  @IsString() orderId: string;
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() comment?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) photos?: string[];
}

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateReviewDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true, customerId: true, vendorId: true, serviceId: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.customerId !== userId) throw new ForbiddenException('Not your order');
    if (order.status !== 'COMPLETED' && order.status !== 'INVOICED' && order.status !== 'CLOSED') {
      throw new BadRequestException('Can only review completed orders');
    }

    // Race condition fix: the "already reviewed?" check and the create() below used to be
    // two separate statements — two near-simultaneous submits (a double-tap, or a retried
    // request) could both pass the check before either commits, producing two reviews for
    // the same order and skewing the vendor's average. Locking the Order row first (same
    // idiom as PartnerLedgerService.postEntry()'s vendor-row lock) serializes concurrent
    // attempts for the same order — the second one's check always sees the first's
    // now-committed review. This also makes the rating recompute below atomic with the
    // review insert, so a crash in between can no longer leave the average one review stale.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${dto.orderId} FOR UPDATE`;
      const existing = await tx.review.findFirst({ where: { orderId: dto.orderId, userId } });
      if (existing) throw new BadRequestException('You have already reviewed this order');

      const review = await tx.review.create({
        data: {
          orderId: dto.orderId,
          userId,
          vendorId: order.vendorId || undefined,
          serviceId: order.serviceId || undefined,
          rating: dto.rating,
          comment: dto.comment || null,
          photos: dto.photos || [],
        },
      });

      // Update vendor rating
      if (order.vendorId) {
        const agg = await tx.review.aggregate({
          where: { vendorId: order.vendorId },
          _avg: { rating: true },
          _count: { id: true },
        });
        await tx.serviceVendor.update({
          where: { id: order.vendorId },
          data: {
            rating: Math.round((agg._avg.rating || 0) * 10) / 10,
          },
        });
      }

      return review;
    });
  }

  async listForService(serviceId: string, limit = 20) {
    return this.prisma.review.findMany({
      where: { serviceId },
      include: { user: { select: { name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async listForVendor(vendorId: string, limit = 20) {
    return this.prisma.review.findMany({
      where: { vendorId },
      include: { user: { select: { name: true, avatarUrl: true } }, service: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async myReviews(userId: string) {
    return this.prisma.review.findMany({
      where: { userId },
      include: { service: { select: { name: true } }, order: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}

// ─── Controller ───

@ApiTags('Reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private reviews: ReviewsService) {}

  // Public: list reviews for a service
  @Public()
  @Get('service/:serviceId')
  forService(@Param('serviceId') id: string, @Query('limit') limit?: number) {
    return this.reviews.listForService(id, limit ? +limit : 20);
  }

  // Public: list reviews for a vendor
  @Public()
  @Get('vendor/:vendorId')
  forVendor(@Param('vendorId') id: string, @Query('limit') limit?: number) {
    return this.reviews.listForVendor(id, limit ? +limit : 20);
  }

  // Auth: submit a review
  @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() u: JwtPayload, @Body() dto: CreateReviewDto) {
    return this.reviews.create(u.sub, dto);
  }

  // Auth: my reviews
  @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  @Get('mine')
  mine(@CurrentUser() u: JwtPayload) {
    return this.reviews.myReviews(u.sub);
  }
}

@Module({
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
