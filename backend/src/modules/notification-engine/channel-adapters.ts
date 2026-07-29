import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.module';
import { WhatsappService } from '../whatsapp/whatsapp.module';
import { FcmService } from './fcm.service';
import { NotificationGateway } from './notification.gateway';

export interface ChannelSendInput {
  notificationId: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, any>;
  orderId?: string;
  actionUrl?: string;
}

// One place per channel. Adding a new channel later (real SMS/email/voice-call
// provider) means adding one method here — nothing else in the engine or in
// business modules needs to change, since they only ever pass `channels: [...]`.
@Injectable()
export class ChannelAdapters {
  private readonly logger = new Logger(ChannelAdapters.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private fcm: FcmService,
    private wa: WhatsappService,
    private gateway: NotificationGateway,
  ) {}

  async sendInApp(input: ChannelSendInput) {
    // The Notification row itself was already created by the caller (NotificationEngineService.notify)
    // before fanning out to channels — this just fires the realtime tick for an open tab.
    this.gateway.emitToUser(input.userId, 'notification', {
      id: input.notificationId,
      title: input.title,
      body: input.body,
      type: input.type,
      data: input.data,
      orderId: input.orderId,
    });
  }

  async sendPush(input: ChannelSendInput) {
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId: input.userId, isActive: true } });
    if (!tokens.length) return;

    const deliveries = await Promise.all(
      tokens.map((t) => this.prisma.notificationDelivery.create({
        data: {
          notificationId: input.notificationId, channel: NotificationChannel.PUSH, deviceTokenId: t.id, status: 'QUEUED',
          type: input.type, data: { ...(input.data || {}), orderId: input.orderId },
        },
      })),
    );

    const dataPayload: Record<string, string> = { type: input.type, orderId: input.orderId || '' };
    if (input.data) for (const k of Object.keys(input.data)) dataPayload[k] = String(input.data[k]);

    const result = await this.fcm.sendToTokens(tokens.map((t) => t.token), {
      title: input.title, body: input.body, data: dataPayload,
    });

    await Promise.all(deliveries.map((d, i) =>
      this.prisma.notificationDelivery.update({
        where: { id: d.id },
        data: result.deadTokens.includes(tokens[i].token)
          ? { status: 'FAILED', lastError: 'dead_token', attempts: { increment: 1 } }
          : { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, nextAttemptAt: null },
      }),
    ));

    if (result.deadTokens.length) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: result.deadTokens } },
        data: { isActive: false },
      });
    }
  }

  async sendWhatsapp(input: ChannelSendInput) {
    try {
      if (input.data?.order && (input.type === 'JOB_OFFER' || input.type === 'JOB_OFFER_WA_FALLBACK')) {
        await this.wa.sendJobAssigned(input.userId, input.data.order);
        return;
      }
      const user = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { phone: true } });
      if (!user?.phone) return;
      await this.wa.sendCustom(user.phone, `${input.title}\n${input.body}`);
    } catch (e) {
      this.logger.warn(`WhatsApp channel adapter failed for user ${input.userId}: ${e.message}`);
    }
  }
}
