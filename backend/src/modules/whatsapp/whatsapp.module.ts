import { Module, Injectable, Logger } from '@nestjs/common';
import { Language, WhatsappMessageType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';

// ─── Multilingual templates ───
const TEMPLATES: Record<string, Record<string, (v: any) => string>> = {
  OTP: {
    EN: (v) => `🔐 Your Remont OTP is ${v.otp}. Valid for 10 min. Do NOT share.`,
    HI: (v) => `🔐 आपका Remont OTP है ${v.otp}. 10 मिनट तक मान्य। शेयर न करें।`,
  },
  JOB_ASSIGNED: {
    EN: (v) =>
      `🛠️ New Job!\nOrder: #${v.orderNumber}\nCustomer: ${v.customerName}\nService: ${v.serviceName}\nTime: ${v.slot}\nAddress: ${v.address}\n📍 ${v.mapLink}\nStart OTP: ${v.startOtp}`,
    HI: (v) =>
      `🛠️ Naya Job!\nOrder: #${v.orderNumber}\nCustomer: ${v.customerName}\nService: ${v.serviceName}\nTime: ${v.slot}\nAddress: ${v.address}\n📍 ${v.mapLink}\nStart OTP: ${v.startOtp}`,
  },
  PAYMENT_RECEIVED: {
    EN: (v) => `✅ ₹${v.amount} received for order #${v.orderNumber}. ₹${v.payout} added to wallet.`,
    HI: (v) => `✅ Order #${v.orderNumber} ka ₹${v.amount} mil gaya. ₹${v.payout} wallet mein add.`,
  },
  PAYMENT_SUCCESS_CUSTOMER: {
    EN: (v) => `✅ Payment of ₹${v.amount} received for order #${v.orderNumber}. Your booking is confirmed!`,
    HI: (v) => `✅ Order #${v.orderNumber} ke liye ₹${v.amount} ka payment mil gaya. Aapki booking confirm ho gayi hai!`,
  },
  PAYMENT_FAILED: {
    EN: (v) => `❌ Payment failed for order #${v.orderNumber}${v.reason ? `: ${v.reason}` : ''}. Tap to retry or pay via Cash on Delivery.`,
    HI: (v) => `❌ Order #${v.orderNumber} ka payment fail ho gaya${v.reason ? `: ${v.reason}` : ''}. Retry karein ya Cash on Delivery chunein.`,
  },
  REFUND_PROCESSED: {
    EN: (v) => `↩️ Your refund of ₹${v.amount} for order #${v.orderNumber} has been ${v.decision}${v.mode ? ` (${v.mode})` : ''}.`,
    HI: (v) => `↩️ Order #${v.orderNumber} ka ₹${v.amount} refund ${v.decision} ho gaya hai${v.mode ? ` (${v.mode})` : ''}.`,
  },
  BALANCE_DUE_REMINDER: {
    EN: (v) => `💳 ₹${v.amount} is due on order #${v.orderNumber}${v.reason ? ` (${v.reason})` : ''}. Pay online anytime from your account.`,
    HI: (v) => `💳 Order #${v.orderNumber} par ₹${v.amount} baaki hai${v.reason ? ` (${v.reason})` : ''}. Apne account se kabhi bhi online pay karein.`,
  },
  WORK_COMPLETED: {
    EN: (v) => `🎉 Your service for order #${v.orderNumber} is complete. Please rate your experience!`,
    HI: (v) => `🎉 Order #${v.orderNumber} ka kaam complete ho gaya. Apna anubhav rate karein!`,
  },
  PAY_ONLINE_NUDGE: {
    EN: (v) => `📱 Pay online for order #${v.orderNumber} — faster, secure, and cashless. Switch from Cash on Delivery anytime before work starts.`,
    HI: (v) => `📱 Order #${v.orderNumber} ke liye online pay karein — tez, surakshit, cashless. Kaam shuru hone se pehle COD se online badal sakte hain.`,
  },
  SERVICE_OTP_RESENT: {
    EN: (v) => `🔐 New ${v.otpLabel} OTP for order #${v.orderNumber} is ${v.otp}. Share only with your assigned technician. The previous code no longer works.`,
    HI: (v) => `🔐 Order #${v.orderNumber} ka naya ${v.otpLabel} OTP ${v.otp} hai. Sirf apne assigned technician ke saath share karein. Purana code ab kaam nahi karega.`,
  },
  EXTRA_WORK: {
    // No inbound handler reads replies — approval is in the customer's Remont app/website or
    // by giving the technician the OTP, so the message must not ask for a YES/NO reply.
    EN: (v) => `📝 Extra work for #${v.orderNumber}:\n${v.description}\nAmount: ₹${v.amount}\nNot billed until you approve it in the Remont app or share the OTP with your technician.`,
    HI: (v) => `📝 Order #${v.orderNumber} extra:\n${v.description}\nAmount: ₹${v.amount}\nAapki approval (Remont app ya technician ko OTP) ke bina bill mein nahi judega.`,
  },
  EXTRA_WORK_OTP: {
    EN: (v) => `🔐 OTP to approve extra work${v.amount != null ? ` of ₹${v.amount}` : ''} on order #${v.orderNumber} is ${v.otp}. Valid 10 min. Share only with your assigned technician.`,
    HI: (v) => `🔐 Order #${v.orderNumber} ke extra work${v.amount != null ? ` (₹${v.amount})` : ''} ko approve karne ka OTP ${v.otp} hai. 10 min tak valid. Sirf apne assigned technician ke saath share karein.`,
  },
  EARNINGS_NUDGE: {
    EN: (v) => `💰 ${v.name}! ${v.openJobs} jobs near you ~₹${v.potential}. Open app to accept.`,
    HI: (v) => `💰 ${v.name}! Aapke area mein ${v.openJobs} jobs, ~₹${v.potential} earning.`,
  },
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  constructor(private prisma: PrismaService) {}

  async sendOtp(phone: string, otp: string) {
    const lang = await this.getLang(phone);
    const body = this.render('OTP', lang, { otp });
    return this.send(phone, body, WhatsappMessageType.OTP);
  }

  async sendJobAssigned(vendorUserId: string, order: any) {
    const vendor = await this.prisma.serviceVendor.findUnique({
      where: { userId: vendorUserId },
      include: { user: true },
    });
    if (!vendor) return;
    const mapLink = order.address
      ? `https://www.google.com/maps?q=${order.address.latitude},${order.address.longitude}`
      : '';
    const body = this.render('JOB_ASSIGNED', vendor.preferredLanguage, {
      orderNumber: order.orderNumber,
      customerName: order.customer?.name || 'Customer',
      serviceName: order.service?.name || 'Service',
      slot: order.slotStart ? new Date(order.slotStart).toLocaleString('en-IN') : 'TBD',
      address: order.address?.fullAddress || '',
      mapLink,
      startOtp: order.startOtp || '',
    });
    return this.send(vendor.user.phone, body, WhatsappMessageType.ORDER_ASSIGNED, {
      vendorId: vendor.id, orderId: order.id,
    });
  }

  async sendExtraWorkApproval(phone: string, orderNumber: string, description: string, amount: number) {
    const lang = await this.getLang(phone);
    const body = this.render('EXTRA_WORK', lang, { orderNumber, description, amount });
    return this.send(phone, body, WhatsappMessageType.EXTRA_WORK_APPROVAL);
  }

  async sendPaymentReceived(phone: string, orderNumber: string, amount: number, payout: number) {
    const lang = await this.getLang(phone);
    const body = this.render('PAYMENT_RECEIVED', lang, { orderNumber, amount, payout });
    return this.send(phone, body, WhatsappMessageType.PAYMENT_RECEIVED);
  }

  async sendPaymentSuccessCustomer(phone: string, orderNumber: string, amount: number) {
    const lang = await this.getLang(phone);
    const body = this.render('PAYMENT_SUCCESS_CUSTOMER', lang, { orderNumber, amount });
    return this.send(phone, body, WhatsappMessageType.PAYMENT_RECEIVED);
  }

  async sendPaymentFailed(phone: string, orderNumber: string, reason?: string) {
    const lang = await this.getLang(phone);
    const body = this.render('PAYMENT_FAILED', lang, { orderNumber, reason });
    return this.send(phone, body, WhatsappMessageType.PAYMENT_FAILED);
  }

  async sendRefundProcessed(phone: string, orderNumber: string, amount: number, decision: string, mode?: string) {
    const lang = await this.getLang(phone);
    const body = this.render('REFUND_PROCESSED', lang, { orderNumber, amount, decision, mode });
    return this.send(phone, body, WhatsappMessageType.REFUND_PROCESSED);
  }

  async sendBalanceDueReminder(phone: string, orderNumber: string, amount: number, reason?: string) {
    const lang = await this.getLang(phone);
    const body = this.render('BALANCE_DUE_REMINDER', lang, { orderNumber, amount, reason });
    return this.send(phone, body, WhatsappMessageType.BALANCE_DUE_REMINDER);
  }

  async sendWorkCompleted(phone: string, orderNumber: string) {
    const lang = await this.getLang(phone);
    const body = this.render('WORK_COMPLETED', lang, { orderNumber });
    return this.send(phone, body, WhatsappMessageType.WORK_COMPLETED);
  }

  async sendPayOnlineNudge(phone: string, orderNumber: string) {
    const lang = await this.getLang(phone);
    const body = this.render('PAY_ONLINE_NUDGE', lang, { orderNumber });
    return this.send(phone, body, WhatsappMessageType.PAY_ONLINE_NUDGE);
  }

  async sendServiceOtpResent(phone: string, orderNumber: string, otpType: 'START' | 'END', otp: string) {
    const lang = await this.getLang(phone);
    const otpLabel = otpType === 'START' ? 'arrival' : 'completion';
    const body = this.render('SERVICE_OTP_RESENT', lang, { orderNumber, otp, otpLabel });
    return this.send(phone, body, WhatsappMessageType.SERVICE_OTP_RESENT);
  }

  /**
   * MSG91_EXTRA_WORK_OTP_TEMPLATE_ID, when set, sends through a dedicated DLT-approved flow
   * template with named variables (##otp##, ##order##, ##amount##) — the shared template
   * below only ever receives the whole text as one `message` variable. The code is masked in
   * WhatsappLog either way, and the result says whether the provider accepted the message.
   */
  async sendExtraWorkOtp(phone: string, orderNumber: string, otp: string, amount?: number) {
    const lang = await this.getLang(phone);
    const body = this.render('EXTRA_WORK_OTP', lang, { orderNumber, otp, amount });
    const templateId = process.env.MSG91_EXTRA_WORK_OTP_TEMPLATE_ID;
    return this.send(phone, body, WhatsappMessageType.EXTRA_WORK_OTP, {}, {
      redact: otp,
      ...(templateId ? { template: { id: templateId, vars: { otp, order: orderNumber, amount: amount != null ? String(amount) : '' } } } : {}),
    });
  }

  /** Plain-text message with no template — used by flows (like seller-registration review
   * outcomes) that don't have a dedicated multilingual template yet. No email/SMS provider
   * is configured, so this is the only real notification channel for those flows today. */
  async sendCustom(phone: string, body: string) {
    return this.send(phone, body, WhatsappMessageType.CUSTOM);
  }

  // ─── Internal helpers ───
  /**
   * Returns the WhatsappLog row plus `delivered` — whether the provider accepted the message.
   * `opts.redact` is a secret (an OTP) that must not be stored in WhatsappLog or logged;
   * `opts.template` sends through a specific MSG91 flow template with named variables.
   */
  private async send(
    toPhone: string, body: string, type: WhatsappMessageType,
    meta: { vendorId?: string; orderId?: string; leadId?: string } = {},
    opts: { redact?: string; template?: { id: string; vars: Record<string, string> } } = {},
  ) {
    const storedBody = opts.redact ? body.split(opts.redact).join('****') : body;
    const log = await this.prisma.whatsappLog.create({
      data: { toPhone, messageType: type, messageBody: storedBody, templateUsed: type, status: 'SENT', ...meta },
    });
    let delivered = false;

    if (process.env.MSG91_AUTH_KEY) {
      const mobileNumber = toPhone.replace('+', '').replace(/\s/g, '');
      try {
        const res = await fetch('https://api.msg91.com/api/v5/flow/', {
          method: 'POST',
          headers: {
            'authkey': process.env.MSG91_AUTH_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template_id: opts.template?.id || process.env.MSG91_OTP_TEMPLATE_ID || process.env.MSG91_TEMPLATE_ID,
            short_url: '0',
            realTimeResponse: '1',
            recipients: [opts.template ? { mobiles: mobileNumber, ...opts.template.vars } : { mobiles: mobileNumber, message: body }],
          }),
        });
        const result = await res.json() as any;
        if (!res.ok || result.type === 'error') {
          this.logger.warn(`MSG91 send failed for ${toPhone} (${type}): ${JSON.stringify(result)}`);
          await this.prisma.whatsappLog.update({ where: { id: log.id }, data: { status: 'FAILED' } });
        } else {
          delivered = true;
          this.logger.log(`📤 MSG91 sent to ${toPhone} (${type})`);
        }
      } catch (e) {
        this.logger.error(`MSG91 HTTP error for ${toPhone}: ${e.message}`);
        await this.prisma.whatsappLog.update({ where: { id: log.id }, data: { status: 'FAILED' } });
      }
    } else if (process.env.NODE_ENV === 'production') {
      // No provider in production means nothing was sent — never record that as SENT.
      this.logger.error(`MSG91_AUTH_KEY is not set — ${type} to ${toPhone} was NOT sent`);
      await this.prisma.whatsappLog.update({ where: { id: log.id }, data: { status: 'FAILED' } });
    } else {
      delivered = true; // local/dev: printed instead of sent
      this.logger.debug(`📱 [DEV] WhatsApp → ${toPhone}:\n${storedBody}`);
    }
    return { ...log, delivered };
  }

  private render(key: string, lang: Language, vars: any): string {
    const tpl = TEMPLATES[key];
    const fn = tpl?.[lang] || tpl?.[Language.EN];
    return fn ? fn(vars) : `[${key}] ${JSON.stringify(vars)}`;
  }

  private async getLang(phone: string): Promise<Language> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    return user?.language || Language.EN;
  }
}

@Module({
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
