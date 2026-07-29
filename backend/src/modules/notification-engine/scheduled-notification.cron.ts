import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.module';
import { NotificationEngineService } from './notification-engine.service';

// Same @Cron/CronExpression pattern already established in
// backend/src/modules/amc/amc.module.ts's dailyAmcCheck() — reused here, not reinvented.
@Injectable()
export class ScheduledNotificationCron {
  private readonly logger = new Logger(ScheduledNotificationCron.name);

  constructor(private prisma: PrismaService, private engine: NotificationEngineService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    const due = await this.prisma.scheduledNotification.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: new Date() } },
      take: 100,
    });
    if (!due.length) return;

    for (const s of due) {
      try {
        if (s.userId) {
          await this.engine.notify({
            userId: s.userId, title: s.title, body: s.body, type: 'SCHEDULED',
            data: (s.data as Record<string, any>) || undefined, channels: s.channels,
          });
        } else if (s.topic) {
          await this.engine.broadcast({ title: s.title, body: s.body, type: 'SCHEDULED', data: (s.data as Record<string, any>) || undefined });
        }
        await this.prisma.scheduledNotification.update({ where: { id: s.id }, data: { status: 'SENT', sentAt: new Date() } });
      } catch (e) {
        this.logger.warn(`Scheduled notification ${s.id} failed: ${e.message}`);
        await this.prisma.scheduledNotification.update({ where: { id: s.id }, data: { status: 'FAILED' } });
      }
    }
  }
}
