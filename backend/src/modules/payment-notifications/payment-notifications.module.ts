import { Module, Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';
import { NotificationsService, NotificationsModule } from '../notifications/notifications.module';

/**
 * Single place that pairs a WhatsApp send with an in-app Notification row for every
 * payment-lifecycle event — previously WhatsappService.sendPaymentReceived() was fully
 * templated but never called from anywhere, and NotificationsService.create() was never
 * called from anywhere in the codebase at all (confirmed by the audit), so the in-app
 * notification bell never populated regardless of what happened to an order's payment.
 * Centralizing here means every call site gets both channels without having to remember to
 * wire each one separately, and a call site can't silently emit a WhatsApp message while
 * forgetting the in-app one (or vice versa).
 */
@Injectable()
export class PaymentNotificationsService {
  constructor(private wa: WhatsappService, private notifications: NotificationsService) {}

  async paymentSuccess(userId: string, phone: string, orderNumber: string, amount: number, orderId?: string) {
    await Promise.all([
      this.wa.sendPaymentSuccessCustomer(phone, orderNumber, amount).catch(() => {}),
      this.notifications.create(userId, {
        title: 'Payment Successful',
        body: `₹${amount} received for order #${orderNumber}. Your booking is confirmed!`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
        orderId,
      }).catch(() => {}),
    ]);
  }

  async paymentFailed(userId: string, phone: string, orderNumber: string, reason?: string, orderId?: string) {
    await Promise.all([
      this.wa.sendPaymentFailed(phone, orderNumber, reason).catch(() => {}),
      this.notifications.create(userId, {
        title: 'Payment Failed',
        body: `Payment failed for order #${orderNumber}${reason ? `: ${reason}` : ''}. Retry or switch to Cash on Delivery.`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
        orderId,
      }).catch(() => {}),
    ]);
  }

  async refundProcessed(userId: string, phone: string, orderNumber: string, amount: number, decision: string, mode?: string, orderId?: string) {
    await Promise.all([
      this.wa.sendRefundProcessed(phone, orderNumber, amount, decision, mode).catch(() => {}),
      this.notifications.create(userId, {
        title: 'Refund Update',
        body: `Your refund of ₹${amount} for order #${orderNumber} has been ${decision}${mode ? ` (${mode})` : ''}.`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
        orderId,
      }).catch(() => {}),
    ]);
  }

  async balanceDue(userId: string, phone: string, orderNumber: string, amount: number, reason?: string, orderId?: string) {
    await Promise.all([
      this.wa.sendBalanceDueReminder(phone, orderNumber, amount, reason).catch(() => {}),
      this.notifications.create(userId, {
        title: 'Balance Due',
        body: `₹${amount} is due on order #${orderNumber}${reason ? ` (${reason})` : ''}.`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
        orderId,
      }).catch(() => {}),
    ]);
  }

  async workCompleted(userId: string, phone: string, orderNumber: string, orderId?: string) {
    await Promise.all([
      this.wa.sendWorkCompleted(phone, orderNumber).catch(() => {}),
      this.notifications.create(userId, {
        title: 'Work Completed',
        body: `Your service for order #${orderNumber} is complete. Please rate your experience!`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
        orderId,
      }).catch(() => {}),
    ]);
  }

  /** One-time nudge encouraging a COD customer to switch to online payment. */
  async payOnlineNudge(userId: string, phone: string, orderNumber: string, orderId?: string) {
    await Promise.all([
      this.wa.sendPayOnlineNudge(phone, orderNumber).catch(() => {}),
      this.notifications.create(userId, {
        title: 'Pay Online — Faster & Secure',
        body: `Switch order #${orderNumber} from Cash on Delivery to online payment anytime before work starts.`,
        channels: [NotificationChannel.IN_APP],
        orderId,
      }).catch(() => {}),
    ]);
  }

  /** Help & Support case resolved/updated — WhatsApp leg intentionally skipped (no approved
   * template exists for this yet); the in-app Notification plus the case detail screen itself
   * (which shows the full amount/policy/reason breakdown) is the source of truth for now. */
  async supportCaseUpdate(userId: string, phone: string, orderNumber: string, caseNumber: string, decision: string, reason?: string, orderId?: string) {
    await this.notifications.create(userId, {
      title: 'Support Case Update',
      body: `Case ${caseNumber} on order #${orderNumber}: ${decision}${reason ? ` — ${reason}` : ''}`,
      channels: [NotificationChannel.IN_APP],
      orderId,
    }).catch(() => {});
  }

  /** A partner tapped "Request OTP Again" — the previous code for this specific
   * service order is now invalid; the customer needs the fresh one. */
  async otpResent(userId: string, phone: string, orderNumber: string, otpType: 'START' | 'END', otp: string, orderId?: string) {
    const label = otpType === 'START' ? 'arrival' : 'completion';
    await Promise.all([
      this.wa.sendServiceOtpResent(phone, orderNumber, otpType, otp).catch(() => {}),
      this.notifications.create(userId, {
        title: 'New OTP Sent',
        body: `A new ${label} OTP was requested for order #${orderNumber}. Check your latest code in My Orders.`,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
        orderId,
      }).catch(() => {}),
    ]);
  }
}

@Module({
  imports: [WhatsappModule, NotificationsModule],
  providers: [PaymentNotificationsService],
  exports: [PaymentNotificationsService],
})
export class PaymentNotificationsModule {}
