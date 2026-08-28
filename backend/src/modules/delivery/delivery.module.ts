import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, UseGuards, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DeliveryPartnerType, DeliveryStatus, ShipmentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, findNearestDeliveryPartner } from '../../common';
import { ShipmentService, LogisticsModule } from '../logistics/logistics.module';

// Phase 5 — explicit adjacency map so a rider can never skip a stage or repeat one, mirroring
// the OTP-gated DELIVERED check DeliveryService.updateStatus() already applies to the
// pre-existing Delivery model. Applies to both outbound Shipment and ReturnShipment (their
// status enums are the same ShipmentStatus).
const SHIPMENT_STATUS_NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
  CREATED: [ShipmentStatus.PICKED_UP, ShipmentStatus.FAILED],
  PICKED_UP: [ShipmentStatus.IN_TRANSIT, ShipmentStatus.FAILED],
  IN_TRANSIT: [ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.FAILED],
  OUT_FOR_DELIVERY: [ShipmentStatus.DELIVERED, ShipmentStatus.FAILED],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

// Return-leg ladder is one hop shorter — DELIVERED here means "reached the seller," which has
// no last-mile "out for delivery" concept, so that rung is skipped for ReturnShipment.
const RETURN_SHIPMENT_STATUS_NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
  CREATED: [ShipmentStatus.PICKED_UP, ShipmentStatus.FAILED],
  PICKED_UP: [ShipmentStatus.IN_TRANSIT, ShipmentStatus.FAILED],
  IN_TRANSIT: [ShipmentStatus.DELIVERED, ShipmentStatus.FAILED],
  OUT_FOR_DELIVERY: [],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  constructor(private prisma: PrismaService, private shipments: ShipmentService) {}

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

  async updateStatus(userId: string, deliveryId: string, status: DeliveryStatus, proofPhotoUrl?: string, otp?: string) {
    const partner = await this.prisma.deliveryPartner.findUnique({ where: { userId } });
    if (!partner) throw new NotFoundException();

    // Marking DELIVERED requires the customer's receiver OTP — same customer-hands-the-code
    // pattern as the service start/completion OTPs, so a delivery can't be closed out without
    // the customer actually present to receive it. Deliveries created before this field
    // existed have receiverOtp === null — skip the check for those rather than locking them.
    if (status === DeliveryStatus.DELIVERED) {
      const delivery = await this.prisma.delivery.findFirst({ where: { id: deliveryId, partnerId: partner.id } });
      if (!delivery) throw new NotFoundException();
      if (delivery.receiverOtp && delivery.receiverOtp !== otp) throw new BadRequestException('Invalid delivery OTP');
      return this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status, deliveredAt: new Date(), proofPhotoUrl, receiverOtpVerified: !!delivery.receiverOtp },
      });
    }

    return this.prisma.delivery.updateMany({
      where: { id: deliveryId, partnerId: partner.id },
      data: {
        status,
        ...(status === DeliveryStatus.PICKED_UP ? { pickedUpAt: new Date() } : {}),
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

  private nearest(type: DeliveryPartnerType, lat: number, lng: number, maxKm: number) {
    return findNearestDeliveryPartner(this.prisma, type, lat, lng, maxKm);
  }

  // ─── Phase 5 — rider-facing Shipment (outbound) status advance ──────────────────────
  private async getOwnPartner(userId: string) {
    const partner = await this.prisma.deliveryPartner.findUnique({ where: { userId } });
    if (!partner) throw new NotFoundException('Delivery partner profile not found');
    return partner;
  }

  async updateShipmentStatus(userId: string, shipmentId: string, status: ShipmentStatus, opts: { otp?: string; codConfirmed?: boolean } = {}) {
    const partner = await this.getOwnPartner(userId);
    const shipment = await this.prisma.shipment.findFirst({ where: { id: shipmentId, deliveryPartnerId: partner.id } });
    if (!shipment) throw new NotFoundException();
    if (!SHIPMENT_STATUS_NEXT[shipment.status]?.includes(status)) {
      throw new BadRequestException(`Cannot move shipment from ${shipment.status} to ${status}`);
    }
    if (status === ShipmentStatus.DELIVERED) {
      if (shipment.deliveryOtp && shipment.deliveryOtp !== opts.otp) throw new BadRequestException('Invalid delivery OTP');
      if (shipment.codSettlementStatus === 'COD_EXPECTED' && !opts.codConfirmed) {
        throw new BadRequestException('Confirm cash/UPI collection before marking this COD order delivered');
      }
    }
    const updated = await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status,
        ...(status === ShipmentStatus.DELIVERED ? { deliveredAt: new Date(), deliveryOtpVerified: !!shipment.deliveryOtp } : {}),
      },
    });
    if (status === ShipmentStatus.DELIVERED) {
      if (shipment.codSettlementStatus === 'COD_EXPECTED') await this.shipments.markCodCollected(shipmentId, partner.id);
      await this.shipments.onShipmentDelivered(shipment.orderId);
    }
    return updated;
  }

  async myShipments(userId: string) {
    const p = await this.getOwnPartner(userId);
    return this.prisma.shipment.findMany({ where: { deliveryPartnerId: p.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async codHandover(userId: string) {
    const p = await this.getOwnPartner(userId);
    return this.shipments.codHandover(p.id);
  }

  // ─── Phase 5 — rider-facing ReturnShipment (pickup-from-customer) status advance ────
  async updateReturnShipmentStatus(userId: string, returnShipmentId: string, status: ShipmentStatus, otp?: string) {
    const partner = await this.getOwnPartner(userId);
    const rs = await this.prisma.returnShipment.findFirst({ where: { id: returnShipmentId, deliveryPartnerId: partner.id } });
    if (!rs) throw new NotFoundException();
    if (!RETURN_SHIPMENT_STATUS_NEXT[rs.status]?.includes(status)) {
      throw new BadRequestException(`Cannot move return shipment from ${rs.status} to ${status}`);
    }
    if (status === ShipmentStatus.PICKED_UP && rs.pickupOtp && rs.pickupOtp !== otp) {
      throw new BadRequestException('Invalid pickup OTP');
    }
    return this.prisma.returnShipment.update({
      where: { id: returnShipmentId },
      data: { status, ...(status === ShipmentStatus.PICKED_UP ? { pickupOtpVerified: !!rs.pickupOtp } : {}) },
    });
  }

  async myReturnShipments(userId: string) {
    const p = await this.getOwnPartner(userId);
    return this.prisma.returnShipment.findMany({ where: { deliveryPartnerId: p.id }, orderBy: { createdAt: 'desc' }, take: 50 });
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
    @Body() b: { status: DeliveryStatus; proofPhotoUrl?: string; otp?: string },
  ) { return this.d.updateStatus(u.sub, id, b.status, b.proofPhotoUrl, b.otp); }

  // ─── Phase 5 — outbound Shipment tracking for a real assigned rider ───────────────
  @Get('me/shipments') myShipments(@CurrentUser() u: JwtPayload) { return this.d.myShipments(u.sub); }
  @Patch('shipments/:id/status') shipmentStatus(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { status: ShipmentStatus; otp?: string; codConfirmed?: boolean },
  ) { return this.d.updateShipmentStatus(u.sub, id, b.status, { otp: b.otp, codConfirmed: b.codConfirmed }); }
  @Post('me/cod-handover') codHandover(@CurrentUser() u: JwtPayload) { return this.d.codHandover(u.sub); }

  // ─── Phase 5 — return-pickup (customer -> original seller) tracking ───────────────
  @Get('me/return-shipments') myReturnShipments(@CurrentUser() u: JwtPayload) { return this.d.myReturnShipments(u.sub); }
  @Patch('return-shipments/:id/status') returnShipmentStatus(
    @CurrentUser() u: JwtPayload, @Param('id') id: string,
    @Body() b: { status: ShipmentStatus; otp?: string },
  ) { return this.d.updateReturnShipmentStatus(u.sub, id, b.status, b.otp); }
}

@Module({
  imports: [LogisticsModule],
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
