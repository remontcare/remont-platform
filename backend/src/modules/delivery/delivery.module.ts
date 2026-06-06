import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, UseGuards, NotFoundException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryPartnerType, DeliveryStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, haversineKm } from '../../common';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  constructor(private prisma: PrismaService) {}

  async register(userId: string, data: any) {
    return this.prisma.deliveryPartner.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  async assignForOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { address: true, items: { include: { product: true } } },
    });
    if (!order || !order.address) throw new NotFoundException();

    const { latitude: lat, longitude: lng } = order.address;
    // Prefer technician-as-delivery first (saves cost + extra income for vendors)
    const tech = await this.nearest(DeliveryPartnerType.TECHNICIAN, lat, lng, 5);
    const partner = tech || (await this.nearest(DeliveryPartnerType.COURIER, lat, lng, 25));
    if (!partner) {
      this.logger.warn(`No delivery partner for order ${orderId}`);
      return null;
    }

    const trackingNumber = `RD${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const delivery = await this.prisma.delivery.create({
      data: {
        partnerId: partner.id,
        pickupAddress: 'Remont Hub',
        pickupLat: 0, pickupLng: 0,
        dropAddress: order.address.fullAddress,
        dropLat: lat, dropLng: lng,
        status: DeliveryStatus.ASSIGNED,
        trackingNumber,
        receiverOtp: Math.floor(1000 + Math.random() * 9000).toString(),
        earningAmount: partner.type === DeliveryPartnerType.TECHNICIAN ? 75 : 50,
      },
    });

    await this.prisma.order.update({ where: { id: orderId }, data: { deliveryId: delivery.id } });
    return delivery;
  }

  async updateLocation(userId: string, lat: number, lng: number) {
    return this.prisma.deliveryPartner.update({
      where: { userId },
      data: { currentLatitude: lat, currentLongitude: lng, lastLocationUpdate: new Date() },
    });
  }

  async updateStatus(userId: string, deliveryId: string, status: DeliveryStatus, proofPhotoUrl?: string) {
    const partner = await this.prisma.deliveryPartner.findUnique({ where: { userId } });
    if (!partner) throw new NotFoundException();
    return this.prisma.delivery.updateMany({
      where: { id: deliveryId, partnerId: partner.id },
      data: {
        status,
        ...(status === DeliveryStatus.PICKED_UP ? { pickedUpAt: new Date() } : {}),
        ...(status === DeliveryStatus.DELIVERED ? { deliveredAt: new Date(), proofPhotoUrl } : {}),
      },
    });
  }

  async myDeliveries(userId: string) {
    const p = await this.prisma.deliveryPartner.findUnique({ where: { userId } });
    if (!p) throw new NotFoundException();
    return this.prisma.delivery.findMany({
      where: { partnerId: p.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private async nearest(type: DeliveryPartnerType, lat: number, lng: number, maxKm: number) {
    const ps = await this.prisma.deliveryPartner.findMany({
      where: {
        type, isAvailable: true, status: 'ACTIVE',
        currentLatitude: { not: null }, currentLongitude: { not: null },
      },
      take: 20,
    });
    let best: { partner: any; d: number } | null = null;
    for (const p of ps) {
      const d = haversineKm(lat, lng, p.currentLatitude!, p.currentLongitude!);
      if (d <= maxKm && (!best || d < best.d)) best = { partner: p, d };
    }
    return best?.partner || null;
  }
}

@ApiTags('Delivery')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DELIVERY_PARTNER, UserRole.SERVICE_VENDOR)
@Controller('delivery')
export class DeliveryController {
  constructor(private d: DeliveryService) {}
  @Post('register') reg(@CurrentUser() u: JwtPayload, @Body() b: any) { return this.d.register(u.sub, b); }
  @Patch('me/location') loc(@CurrentUser() u: JwtPayload, @Body() b: { lat: number; lng: number }) {
    return this.d.updateLocation(u.sub, b.lat, b.lng);
  }
  @Get('me/deliveries') mine(@CurrentUser() u: JwtPayload) { return this.d.myDeliveries(u.sub); }
  @Patch(':id/status') status(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { status: DeliveryStatus; proofPhotoUrl?: string },
  ) { return this.d.updateStatus(u.sub, id, b.status, b.proofPhotoUrl); }
}

@Module({
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
