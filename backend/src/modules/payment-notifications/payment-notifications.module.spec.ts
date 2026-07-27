import { NotificationChannel } from '@prisma/client';
import { PaymentNotificationsService } from './payment-notifications.module';

function makeService() {
  const wa: any = {
    sendPaymentSuccessCustomer: jest.fn(async () => ({})),
    sendPaymentFailed: jest.fn(async () => ({})),
    sendRefundProcessed: jest.fn(async () => ({})),
    sendBalanceDueReminder: jest.fn(async () => ({})),
    sendWorkCompleted: jest.fn(async () => ({})),
    sendPayOnlineNudge: jest.fn(async () => ({})),
  };
  const notifications: any = { create: jest.fn(async () => ({})) };
  const svc = new PaymentNotificationsService(wa, notifications);
  return { svc, wa, notifications };
}

describe('PaymentNotificationsService — pairing WhatsApp + in-app notification for every payment event', () => {
  it('paymentSuccess sends both the WhatsApp message and the in-app notification', async () => {
    const { svc, wa, notifications } = makeService();
    await svc.paymentSuccess('user-1', '9999999999', 'REM-1', 500, 'order-1');
    expect(wa.sendPaymentSuccessCustomer).toHaveBeenCalledWith('9999999999', 'REM-1', 500);
    expect(notifications.create).toHaveBeenCalledWith('user-1', expect.objectContaining({
      title: 'Payment Successful', orderId: 'order-1',
      channels: [NotificationChannel.IN_APP, NotificationChannel.WHATSAPP],
    }));
  });

  it('does not throw when the WhatsApp send fails — the in-app notification still gets created', async () => {
    const { svc, wa, notifications } = makeService();
    wa.sendPaymentFailed.mockRejectedValue(new Error('MSG91 down'));
    await expect(svc.paymentFailed('user-1', '9999999999', 'REM-1', 'card declined', 'order-1')).resolves.toBeUndefined();
    expect(notifications.create).toHaveBeenCalled();
  });

  it('does not throw when the in-app notification write fails — the WhatsApp send still happens', async () => {
    const { svc, wa, notifications } = makeService();
    notifications.create.mockRejectedValue(new Error('DB down'));
    await expect(svc.workCompleted('user-1', '9999999999', 'REM-1', 'order-1')).resolves.toBeUndefined();
    expect(wa.sendWorkCompleted).toHaveBeenCalledWith('9999999999', 'REM-1');
  });

  it('payOnlineNudge only uses IN_APP channel for the notification (no WhatsApp double-send of the same nudge)', async () => {
    const { svc, notifications } = makeService();
    await svc.payOnlineNudge('user-1', '9999999999', 'REM-1', 'order-1');
    expect(notifications.create).toHaveBeenCalledWith('user-1', expect.objectContaining({ channels: [NotificationChannel.IN_APP] }));
  });
});
