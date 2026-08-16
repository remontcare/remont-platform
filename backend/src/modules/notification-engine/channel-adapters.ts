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

    // title/body are always included as flat strings — JOB_OFFER's client-side incoming-call
    // UI (see below) has no `notification` block to read them from, so it needs them here.
    const dataPayload: Record<string, string> = { type: input.type, orderId: input.orderId || '', title: input.title, body: input.body };
    if (input.data) {
      for (const k of Object.keys(input.data)) {
        const v = input.data[k];
        // Skip nested objects (e.g. the full `order` on JOB_OFFER) — FCM data values must be
        // strings, and String(anObject) silently degrades to the useless "[object Object]".
        if (v !== null && typeof v === 'object') continue;
        dataPayload[k] = String(v);
      }
    }

    // JOB_OFFER needs full client-side control (flutter_callkit_incoming's ringing UI) even when
    // the app is killed — see FcmService.sendToTokens' dataOnly doc for why that requires
    // skipping the `notification` block rather than just adding data alongside it.
    const result = await this.fcm.sendToTokens(tokens.map((t) => t.token), {
      title: input.title, body: input.body, data: dataPayload, dataOnly: input.type === 'JOB_OFFER',
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
