import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { NotificationEngineService } from './notification-engine.service';

// Same decoupled pattern as agency-notifications.service.ts: orders.module.ts's
// ExtraWorkService only emits these event names and never imports the engine.
@Injectable()
export class ExtraWorkNotificationsService {
  private readonly logger = new Logger(ExtraWorkNotificationsService.name);

  constructor(private engine: NotificationEngineService, private prisma: PrismaService) {}

  private notify(userId: string, title: string, body: string, type: string, data: Record<string, any>) {
    return this.engine
      .notify({ userId, title, body, type, data, orderId: data.orderId, channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH] })
      .catch((e) => this.logger.warn(`${type} notification failed for user ${userId}: ${e.message}`));
  }

  /** Partner added extra work → the customer and the order's Authorized Person are asked to decide. */
  @OnEvent('extraWork.requested')
  async onRequested(p: {
    orderId: string; orderNumber: string; serviceName: string; extraWorkId: string;
    description: string; amount: number; customerId: string; authorizedPhone: string | null;
  }) {
    const title = 'Extra work needs your approval';
    const body = `${p.description} — ₹${p.amount} on ${p.serviceName} (order #${p.orderNumber}). Not billed until approved.`;
    const data = { orderId: p.orderId, extraWorkId: p.extraWorkId };
    await this.notify(p.customerId, title, body, 'EXTRA_WORK_REQUESTED', data);
    if (!p.authorizedPhone) return;
    // Only someone who has signed in has a user to notify; they also got the WhatsApp/SMS notice.
    const authUser = await this.prisma.user.findUnique({ where: { phone: p.authorizedPhone }, select: { id: true } });
    if (authUser && authUser.id !== p.customerId) {
      await this.notify(authUser.id, title, body, 'EXTRA_WORK_REQUESTED', { ...data, authorized: true });
    }
  }

  /** Customer / Authorized Person approved or rejected → the partner on the job is told. */
  @OnEvent('extraWork.decided')
  onDecided(p: {
    orderId: string; orderNumber: string; extraWorkId: string; description: string; amount: number;
    decision: string; reason: string | null; vendorUserId: string;
  }) {
    const approved = p.decision === 'APPROVED';
    const title = approved ? 'Extra work approved' : 'Extra work rejected';
    const body = approved
      ? `${p.description} — ₹${p.amount} added to order #${p.orderNumber}.`
      : `${p.description} — ₹${p.amount} on order #${p.orderNumber} was rejected${p.reason ? `: ${p.reason}` : '.'}`;
    return this.notify(p.vendorUserId, title, body, approved ? 'EXTRA_WORK_APPROVED' : 'EXTRA_WORK_REJECTED',
      { orderId: p.orderId, extraWorkId: p.extraWorkId });
  }
}
