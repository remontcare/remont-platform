import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.module';
import { FcmService } from './fcm.service';

// Generic engine primitive — knows only about NotificationDelivery rows, nothing
// about jobs/orders/rings. A HIGH-priority notification's maxAttempts/nextAttemptAt
// spacing (set by NotificationEngineService.scheduleRetries) is what makes this sweep
// *behave* like a 30s re-ring; the ring-specific policy lives entirely in
// job-ring-policy.service.ts, which just listens for the generic 'notification.exhausted'
// event this sweep emits.
@Injectable()
export class RetrySweepService {
  private readonly logger = new Logger(RetrySweepService.name);

  constructor(
    private prisma: PrismaService,
    private fcm: FcmService,
    private events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async sweep() {
    const due = await this.prisma.notificationDelivery.findMany({
      where: {
        status: { in: ['QUEUED', 'FAILED'] },
        nextAttemptAt: { lte: new Date() },
        ackedAt: null,
      },
      include: { notification: true, deviceToken: true },
      take: 200,
    });
    if (!due.length) return;

    for (const d of due) {
      if (d.attempts >= d.maxAttempts) {
        await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'EXPIRED', nextAttemptAt: null } });
        this.events.emit('notification.exhausted', {
          notificationId: d.notificationId,
          channel: d.channel,
          userId: d.notification.userId,
          type: d.type || '',
          data: (d.data as Record<string, any>) || {},
        });
        continue;
      }
      if (!d.deviceToken?.token) continue;

      const result = await this.fcm.sendToTokens([d.deviceToken.token], {
        title: d.notification.title, body: d.notification.body,
      });
      const spacingMs = 10_000;
      if (result.deadTokens.length) {
        await this.prisma.deviceToken.update({ where: { id: d.deviceToken.id }, data: { isActive: false } });
        await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', lastError: 'dead_token', attempts: { increment: 1 }, nextAttemptAt: null } });
      } else {
        await this.prisma.notificationDelivery.update({
          where: { id: d.id },
          data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + spacingMs) },
        });
      }
    }
  }
}
