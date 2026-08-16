import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { NotificationEngineService } from './notification-engine.service';

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
    const amount = Number(p.order?.totalAmount ?? 0);
    const amountLabel = amount > 0 ? `₹${amount.toLocaleString('en-IN')}` : '';
    const bodyParts = [p.order?.service?.name || 'Service', p.order?.address?.city || '', amountLabel].filter(Boolean);
    await this.engine.notify({
      userId: p.vendorUserId,
      title: 'New Job Available',
      body: bodyParts.join(' • '),
      type: 'JOB_OFFER',
      data: { orderId: p.orderId, order: p.order },
      channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP],
      priority: 'HIGH',
      ttlSeconds: 30,
      orderId: p.orderId,
    });
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
