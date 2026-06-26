import {
  Module, Injectable, Controller, Get, Post, Query, Body, UseGuards,
  BadRequestException, Logger, Headers, Req, OnModuleInit,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload } from '../../common';

interface PhonePeConfig {
  merchantId: string;
  saltKey: string;
  saltIndex: string;
  baseUrl: string;
  enabled: boolean;
}

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  // Razorpay
  private razorpay: any;
  private razorpayKeyId = '';
  private razorpayKeySecret = '';
  private razorpayWebhookSecret = '';

  // PhonePe
  private phonePe: PhonePeConfig = { merchantId: '', saltKey: '', saltIndex: '1', baseUrl: '', enabled: false };

  // Which gateway is the active one
  private activeGateway: 'RAZORPAY' | 'PHONEPE' | '' = '';

  constructor(private prisma: PrismaService) {
    // Bootstrap from env vars — will be overridden by DB in onModuleInit
    this.razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
    this.razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
    this.razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (this.razorpayKeyId && this.razorpayKeySecret) {
      this._initRazorpay(this.razorpayKeyId, this.razorpayKeySecret);
    }
  }

  async onModuleInit() {
    // DB keys override env vars — lets admin change keys without redeploying
    await this.reinitialize();
  }

  private _initRazorpay(keyId: string, keySecret: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Razorpay = require('razorpay');
      this.razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
      this.razorpayKeyId = keyId;
      this.razorpayKeySecret = keySecret;
      this.logger.log(`Razorpay initialized (${keyId.startsWith('rzp_live_') ? 'LIVE' : 'TEST'} mode)`);
    } catch (e) {
      this.logger.error(`Razorpay init failed: ${e.message}`);
      this.razorpay = null;
    }
  }

  /** Re-reads all gateway config from DB and re-initializes clients. Called after admin saves keys. */
  async reinitialize() {
    const rows = await this.prisma.siteSetting.findMany({ where: { group: 'payment' } });
    const s: Record<string, string> = {};
    for (const r of rows) s[r.key] = r.value;

    // Razorpay — DB keys win over env vars
    const rzpId = s['razorpay_key_id'] || process.env.RAZORPAY_KEY_ID || '';
    const rzpSecret = s['razorpay_key_secret'] || process.env.RAZORPAY_KEY_SECRET || '';
    const rzpWebhook = s['razorpay_webhook_secret'] || process.env.RAZORPAY_WEBHOOK_SECRET || '';
    this.razorpayWebhookSecret = rzpWebhook;
    if (rzpId && rzpSecret && (rzpId !== this.razorpayKeyId || rzpSecret !== this.razorpayKeySecret || !this.razorpay)) {
      this._initRazorpay(rzpId, rzpSecret);
    }

    // PhonePe
    const ppMerchant = s['phonepe_merchant_id'] || '';
    const ppSalt = s['phonepe_salt_key'] || '';
    const ppIndex = s['phonepe_salt_index'] || '1';
    const ppEnabled = s['phonepe_enabled'] === 'true';
    const ppMode = s['phonepe_mode'] || 'test';
    this.phonePe = {
      merchantId: ppMerchant,
      saltKey: ppSalt,
      saltIndex: ppIndex,
      enabled: ppEnabled && !!ppMerchant && !!ppSalt,
      baseUrl: ppMode === 'live'
        ? 'https://api.phonepe.com/apis/hermes'
        : 'https://api-preprod.phonepe.com/apis/pg-sandbox',
    };

    // Active gateway
    const stored = s['active_payment_gateway'];
    if (stored === 'PHONEPE' && this.phonePe.enabled) {
      this.activeGateway = 'PHONEPE';
    } else if (this.razorpay) {
      this.activeGateway = 'RAZORPAY';
    } else {
      this.activeGateway = '';
    }

    this.logger.log(`Active payment gateway: ${this.activeGateway || 'NONE'}`);
    return { success: true, activeGateway: this.activeGateway };
  }

  // ─── Razorpay ──────────────────────────────────────────────────────────────

  async createRazorpayOrder(userId: string, amount: number, orderId?: string, amcSubscriptionId?: string) {
    if (!this.razorpay) {
      throw new BadRequestException(
        'Razorpay is not configured. Add your API keys in Admin → Payment Gateways.',
      );
    }
    const rzpOrder = await this.razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: { orderId, amcSubscriptionId, userId },
    });
    const tx = await this.prisma.paymentTransaction.create({
      data: { orderId, amcSubscriptionId, userId, amount, status: 'PENDING', gateway: 'RAZORPAY', gatewayOrderId: rzpOrder.id },
    });
    return { gateway: 'RAZORPAY', gatewayOrderId: rzpOrder.id, amount, currency: 'INR', keyId: this.razorpayKeyId, txId: tx.id };
  }

  /** Legacy alias used by AMC and retry-payment flows */
  async createOrder(userId: string, amount: number, orderId?: string, amcSubscriptionId?: string) {
    return this.createRazorpayOrder(userId, amount, orderId, amcSubscriptionId);
  }

  async verifyAndMarkPaid(gatewayOrderId: string, paymentId: string, signature: string): Promise<boolean> {
    if (!this.razorpayKeySecret) throw new BadRequestException('Razorpay not configured');
    const expected = crypto
      .createHmac('sha256', this.razorpayKeySecret)
      .update(`${gatewayOrderId}|${paymentId}`)
      .digest('hex');
    if (expected !== signature) return false;
    const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId } });
    if (tx && tx.status !== 'PAID') {
      await this.prisma.paymentTransaction.update({
        where: { id: tx.id },
        data: { status: 'PAID', gatewayPaymentId: paymentId, gatewaySignature: signature },
      });
    }
    return true;
  }

  // ─── PhonePe ───────────────────────────────────────────────────────────────

  async createPhonePeOrder(userId: string, amount: number, orderId: string, frontendUrl: string) {
    const cfg = this.phonePe;
    if (!cfg.merchantId || !cfg.saltKey) {
      throw new BadRequestException('PhonePe is not configured. Add API keys in Admin → Payment Gateways.');
    }
    const merchantTransactionId = `REMONT_${orderId.slice(-8).toUpperCase()}_${Date.now()}`;
    const redirectUrl = `${frontendUrl}/payment-return?gateway=phonepe&txId=${merchantTransactionId}&dbOrderId=${orderId}`;

    const payload = {
      merchantId: cfg.merchantId,
      merchantTransactionId,
      amount: Math.round(amount * 100),
      redirectUrl,
      redirectMode: 'GET',
      paymentInstrument: { type: 'PAY_PAGE' },
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const endpoint = '/pg/v1/pay';
    const signature = crypto.createHash('sha256')
      .update(base64Payload + endpoint + cfg.saltKey)
      .digest('hex') + '###' + cfg.saltIndex;

    const resp = await fetch(`${cfg.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VERIFY': signature, 'X-MERCHANT-ID': cfg.merchantId },
      body: JSON.stringify({ request: base64Payload }),
    });
    const data: any = await resp.json();
    if (!data.success) throw new BadRequestException(data.message || 'PhonePe payment creation failed');

    const tx = await this.prisma.paymentTransaction.create({
      data: { orderId, userId, amount, status: 'PENDING', gateway: 'PHONEPE', gatewayOrderId: merchantTransactionId },
    });
    return {
      gateway: 'PHONEPE',
      redirectUrl: data.data.instrumentResponse.redirectInfo.url,
      txId: merchantTransactionId,
      dbTxId: tx.id,
    };
  }

  async verifyPhonePePayment(merchantTransactionId: string): Promise<{ success: boolean; state: string; paymentId?: string }> {
    const cfg = this.phonePe;
    if (!cfg.merchantId || !cfg.saltKey) throw new BadRequestException('PhonePe not configured');

    const endpoint = `/pg/v1/status/${cfg.merchantId}/${merchantTransactionId}`;
    const signature = crypto.createHash('sha256')
      .update(endpoint + cfg.saltKey)
      .digest('hex') + '###' + cfg.saltIndex;

    const resp = await fetch(`${cfg.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: { 'X-VERIFY': signature, 'X-MERCHANT-ID': cfg.merchantId, 'Content-Type': 'application/json' },
    });
    const data: any = await resp.json();
    const success = data.success && data.data?.state === 'COMPLETED';
    const paymentId = data.data?.transactionId;

    if (success) {
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId: merchantTransactionId } });
      if (tx && tx.status !== 'PAID') {
        await this.prisma.paymentTransaction.update({
          where: { id: tx.id },
          data: { status: 'PAID', gatewayPaymentId: paymentId },
        });
      }
    }
    return { success, state: data.data?.state || 'UNKNOWN', paymentId };
  }

  // ─── Unified payment initiation ────────────────────────────────────────────

  async initiatePayment(userId: string, amount: number, orderId: string, frontendUrl: string) {
    if (this.activeGateway === 'PHONEPE') {
      return this.createPhonePeOrder(userId, amount, orderId, frontendUrl);
    }
    if (this.activeGateway === 'RAZORPAY') {
      return this.createRazorpayOrder(userId, amount, orderId);
    }
    throw new BadRequestException(
      'No payment gateway configured. Please add API keys in Admin → Payment Gateways.',
    );
  }

  // ─── Webhook ───────────────────────────────────────────────────────────────

  async handleWebhook(rawBody: string, signature: string) {
    const secret = this.razorpayWebhookSecret;
    if (!secret) throw new BadRequestException('Webhook secret not configured');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected !== signature) throw new BadRequestException('Invalid webhook signature');

    const event = JSON.parse(rawBody);
    this.logger.log(`Webhook: ${event.event}`);

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId: payment.order_id } });
      if (tx) {
        await this.prisma.paymentTransaction.update({
          where: { id: tx.id },
          data: { status: 'PAID', gatewayPaymentId: payment.id, gatewaySignature: signature },
        });
        if (tx.orderId) {
          await this.prisma.order.update({
            where: { id: tx.orderId },
            data: { paymentId: payment.id, paymentStatus: 'PAID', status: 'CONFIRMED' },
          });
        }
        if (tx.amcSubscriptionId) {
          await this.prisma.amcSubscription.update({
            where: { id: tx.amcSubscriptionId },
            data: { paymentId: payment.id, status: 'ACTIVE' },
          });
        }
      }
    }

    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId: payment.order_id } });
      if (tx) {
        await this.prisma.paymentTransaction.update({
          where: { id: tx.id },
          data: { status: 'FAILED', gatewayPaymentId: payment.id },
        });
      }
    }
    return { received: true };
  }

  getConfig() {
    return {
      activeGateway: this.activeGateway,
      razorpay: {
        configured: !!this.razorpay,
        keyId: this.razorpayKeyId,
        isLive: this.razorpayKeyId.startsWith('rzp_live_'),
      },
      phonepe: {
        configured: this.phonePe.enabled,
        merchantId: this.phonePe.merchantId,
        isLive: this.phonePe.baseUrl.includes('api.phonepe.com/apis/hermes'),
      },
      currency: 'INR',
    };
  }
}

// ─── Controller ─────────────────────────────────────────────────────────────

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private p: PaymentsService) {}

  @Public() @Get('config')
  config() { return this.p.getConfig(); }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('create-order')
  create(@CurrentUser() u: JwtPayload, @Body() b: { amount: number; orderId?: string; amcSubscriptionId?: string }) {
    return this.p.createOrder(u.sub, b.amount, b.orderId, b.amcSubscriptionId);
  }

  @Public() @Post('verify')
  async verify(@Body() b: { orderId: string; paymentId: string; signature: string }) {
    const valid = await this.p.verifyAndMarkPaid(b.orderId, b.paymentId, b.signature);
    return { valid };
  }

  @Public() @Get('verify-phonepe')
  async verifyPhonePe(@Query('txId') txId: string) {
    if (!txId) throw new BadRequestException('txId required');
    return this.p.verifyPhonePePayment(txId);
  }

  @Public() @Post('webhook')
  webhook(@Headers('x-razorpay-signature') signature: string, @Req() req: RawBodyRequest<any>) {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    return this.p.handleWebhook(rawBody, signature);
  }
}

@Module({ controllers: [PaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
