import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, DevicePlatform, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ChannelAdapters } from './channel-adapters';
import { FcmService } from './fcm.service';
import { NotificationGateway } from './notification.gateway';

export interface NotifyInput {
  userId: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, any>;
  channels?: NotificationChannel[];
  orderId?: string;
  priority?: 'NORMAL' | 'HIGH';
  ttlSeconds?: number;
}

// The only surface business modules would ever inject directly (most won't —
// they emit domain events instead; see job-ring-policy.service.ts for the
// event-driven half of this contract). Kept independent of Orders/Wallet/CRM/
// Marketplace/Payments: this file imports nothing from those modules.
@Injectable()
export class NotificationEngineService {
  private readonly logger = new Logger(NotificationEngineService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private channels: ChannelAdapters,
    private fcm: FcmService,
    private gateway: NotificationGateway,
  ) {}

  async notify(input: NotifyInput): Promise<{ notificationId: string }> {
    const wantedChannels = input.channels?.length ? input.channels : [NotificationChannel.IN_APP, NotificationChannel.PUSH];

    const notification = await this.notifications.create(input.userId, {
      title: input.title,
      body: input.body,
      channels: wantedChannels,
      orderId: input.orderId,
      actionUrl: input.data?.actionUrl,
    });

    const sendInput = {
      notificationId: notification.id, userId: input.userId, title: input.title, body: input.body,
      type: input.type, data: input.data, orderId: input.orderId,
    };

    for (const ch of wantedChannels) {
      try {
        if (ch === NotificationChannel.IN_APP) await this.channels.sendInApp(sendInput);
        else if (ch === NotificationChannel.PUSH) await this.channels.sendPush(sendInput);
        else if (ch === NotificationChannel.WHATSAPP) await this.channels.sendWhatsapp(sendInput);
        // SMS / EMAIL / VOICE: no provider wired yet — future channels slot in here,
        // in channel-adapters.ts, with zero change to notify()'s call sites.
      } catch (e) {
        this.logger.warn(`Channel ${ch} failed for notification ${notification.id}: ${e.message}`);
      }
    }

    if (input.priority === 'HIGH' && wantedChannels.includes(NotificationChannel.PUSH)) {
      await this.scheduleRetries(notification.id, input.ttlSeconds || 30);
    }

    return { notificationId: notification.id };
  }

  // Spaces out up to 3 retry attempts across the given window (e.g. a 30s job-offer
  // window re-rings roughly every 10s) by pushing nextAttemptAt on the PUSH delivery
  // rows this notification just created — retry-sweep.service.ts's cron does the rest.
  private async scheduleRetries(notificationId: string, ttlSeconds: number) {
    const spacingMs = Math.max(5000, Math.floor((ttlSeconds * 1000) / 3));
    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId, channel: NotificationChannel.PUSH },
    });
    await Promise.all(deliveries.map((d) => this.prisma.notificationDelivery.update({
      where: { id: d.id },
      data: { maxAttempts: 3, nextAttemptAt: new Date(Date.now() + spacingMs) },
    })));
  }

  async broadcast(input: { title: string; body: string; type: string; data?: Record<string, any>; role?: UserRole; city?: string }): Promise<{ count: number }> {
    const users = await this.prisma.user.findMany({
      where: { ...(input.role ? { role: input.role } : {}), ...(input.city ? { city: { name: input.city } } : {}) },
      select: { id: true },
      take: 5000,
    });
    for (const u of users) {
      await this.notify({ userId: u.id, title: input.title, body: input.body, type: input.type, data: input.data, channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH] });
    }
    return { count: users.length };
  }

  async subscribeTopic(userId: string, topic: string): Promise<void> {
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId, isActive: true } });
    await this.fcm.subscribeToTopic(tokens.map((t) => t.token), topic);
    await this.prisma.deviceToken.updateMany({ where: { userId, isActive: true }, data: { subscribedTopics: { push: topic } } });
  }

  async unsubscribeTopic(userId: string, topic: string): Promise<void> {
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId, isActive: true } });
    await this.fcm.unsubscribeFromTopic(tokens.map((t) => t.token), topic);
  }

  async schedule(input: NotifyInput & { scheduledFor: Date }): Promise<{ id: string }> {
    const row = await this.prisma.scheduledNotification.create({
      data: {
        userId: input.userId, title: input.title, body: input.body,
        data: input.data || {}, channels: input.channels?.length ? input.channels : [NotificationChannel.IN_APP, NotificationChannel.PUSH],
        scheduledFor: input.scheduledFor,
      },
    });
    return { id: row.id };
  }

  async cancelScheduled(id: string): Promise<void> {
    await this.prisma.scheduledNotification.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  }

  async registerDevice(userId: string, token: string, platform: DevicePlatform, meta?: { userAgent?: string }): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform, userAgent: meta?.userAgent },
      update: { userId, isActive: true, lastSeenAt: new Date(), userAgent: meta?.userAgent },
    });
  }

  async unregisterDevice(token: string): Promise<void> {
    await this.prisma.deviceToken.updateMany({ where: { token }, data: { isActive: false } });
  }

  async ackDelivery(deliveryId: string, event: 'DELIVERED' | 'OPENED'): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: { ackedAt: new Date(), status: 'DELIVERED', nextAttemptAt: null },
    });
  }

  /** WS-only, no DB row, no push — Task 9's "live screen refresh" primitive. */
  pushRealtime(userId: string, event: string, payload: any): void {
    this.gateway.emitToUser(userId, event, payload);
  }
}
