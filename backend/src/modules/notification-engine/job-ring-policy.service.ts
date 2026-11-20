import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { NotificationEngineService } from './notification-engine.service';
import { partnerOfferView } from '../../common';
import { buildJobRingDetails } from './job-ring-details';

// Ring-specific POLICY, not generic engine core — lives in this folder because it's
// the one thing Task 7 (incoming-job ring) actually needs, but everything it touches
// (notify(), the 'notification.exhausted' event) is a generic primitive any other
// domain could reuse the same way. Orders/Vendors modules never import this file;
// they only ever emit 'job.offer.created' — this listens.
@Injectable()
export class JobRingPolicyService {
  private readonly logger = new Logger(JobRingPolicyService.name);

  constructor(
    private prisma: PrismaService,
    private engine: NotificationEngineService,
    private events: EventEmitter2,
  ) {}

  @OnEvent('job.offer.created')
  async onJobOffer(p: { vendorUserId: string; orderId: string; order: any }) {
    // The order as it is NOW — a reschedule between dispatch and this ring must be what the
    // partner hears. Falls back to the emitted snapshot if the read fails (never blocks a ring).
    const order = (await this.latestOrder(p.orderId)) ?? p.order;
    const details = buildJobRingDetails(order, await this.vendorLocation(p.vendorUserId));

    const amount = Number(order?.totalAmount ?? 0);
    const amountLabel = amount > 0 ? `₹${amount.toLocaleString('en-IN')}` : '';
    // Area + when, so a ring for a scheduled visit never reads as "go now". Older app versions
    // split this on ' • ' (₹ part as headline, the rest as subtitle) — kept for them.
    const where = order?.address?.area || order?.address?.city || '';
    const slot = order?.slotStart ? new Date(order.slotStart) : null;
    const whenLabel = slot && !Number.isNaN(slot.getTime())
      ? slot.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
      : 'ASAP';
    const bodyParts = [order?.service?.name || 'Service', where, whenLabel, amountLabel, details.distance ? `${details.distance} away` : ''].filter(Boolean);
    await this.engine.notify({
      userId: p.vendorUserId,
      title: 'New Job Available',
      body: bodyParts.join(' • '),
      type: 'JOB_OFFER',
      // Minimal offer view only: this payload is pushed over the socket AND stored on the
      // Notification/NotificationDelivery rows, so it must never carry the full Order
      // (customer address/contact, payment, OTP or internal fields). The ring* strings are what
      // the call announces (flat strings — FCM data values cannot be objects).
      data: {
        orderId: p.orderId,
        order: order ? partnerOfferView(order, { distanceKm: details.distanceKm }) : null,
        ringLocation: details.location ?? '',
        ringDate: details.date ?? '',
        ringTime: details.time ?? '',
        ringAmount: details.amount ?? '',
        ringDistance: details.distance ?? '',
        ringSpoken: details.spoken,
        ringService: order?.service?.name || '',
      },
      channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP],
      priority: 'HIGH',
      ttlSeconds: 30,
      orderId: p.orderId,
    });
  }

  private async latestOrder(orderId: string) {
    try {
      return await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { service: { select: { name: true, categoryId: true } }, address: { select: { area: true, city: true, latitude: true, longitude: true } } },
      });
    } catch (e: any) {
      this.logger.warn(`ring: could not re-read order ${orderId}: ${e?.message}`);
      return null;
    }
  }

  /** The partner's latest GPS fix (staleness/validity is judged in buildJobRingDetails). */
  private async vendorLocation(vendorUserId: string) {
    try {
      const v = await this.prisma.serviceVendor.findUnique({
        where: { userId: vendorUserId },
        select: { currentLatitude: true, currentLongitude: true, lastLocationUpdate: true },
      });
      return v ? { latitude: v.currentLatitude, longitude: v.currentLongitude, updatedAt: v.lastLocationUpdate } : null;
    } catch (e: any) {
      this.logger.warn(`ring: could not read partner location: ${e?.message}`);
      return null;
    }
  }

  @OnEvent('notification.exhausted')
  async onExhausted(e: { notificationId: string; channel: NotificationChannel; userId: string; type: string; data: any }) {
    if (e.type !== 'JOB_OFFER') return;
    const orderId = e.data?.orderId;
    if (!orderId) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { address: true, service: true, customer: { select: { name: true } } },
    });
    if (!order || order.vendorId) return; // already accepted/assigned elsewhere — nothing to do

    await this.engine.notify({
      userId: e.userId,
      title: 'New Job Available',
      body: 'A job offer needs your response — check the app.',
      type: 'JOB_OFFER_WA_FALLBACK',
      data: { orderId, order },
      channels: [NotificationChannel.WHATSAPP],
      orderId,
    });

    this.events.emit('job.offer.expired', { orderId, vendorUserId: e.userId });
  }

  // A vendor accepted (directly, or via the ring's Accept button calling the existing
  // acceptJob() endpoint) — stop ringing/escalating this order for every other
  // candidate DispatchService also offered it to.
  @OnEvent('job.offer.resolved')
  async onResolved(e: { orderId: string }) {
    await this.prisma.notificationDelivery.updateMany({
      where: {
        type: { in: ['JOB_OFFER', 'JOB_OFFER_WA_FALLBACK'] },
        status: { in: ['QUEUED', 'SENT', 'FAILED'] },
        ackedAt: null,
        data: { path: ['orderId'], equals: e.orderId },
      },
      data: { status: 'EXPIRED', nextAttemptAt: null },
    });
  }
}
