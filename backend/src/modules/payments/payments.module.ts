import { Module, Injectable, Controller, Get, Post, Body, UseGuards, BadRequestException, Logger, Headers, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private razorpay: any;

  constructor(private prisma: PrismaService) {
    if (process.env.RAZORPAY_KEY_ID) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Razorpay = require('razorpay');
        this.razorpay = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
        this.logger.log(`Razorpay initialized (${process.env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'LIVE' : 'TEST'} mode)`);
      } catch (e) {
        this.logger.error('Failed to initialize Razorpay. Ensure razorpay package is installed.');
      }
    } else {
      this.logger.warn('RAZORPAY_KEY_ID not set — payment gateway disabled');
    }
  }

  async createOrder(userId: string, amount: number, orderId?: string, amcSubscriptionId?: string) {
    if (!this.razorpay) {
      throw new BadRequestException(
        'Payment gateway is not configured. Please contact support or choose Cash on Delivery.',
      );
    }

    const rzpOrder = await this.razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: { orderId, amcSubscriptionId, userId },
    });

    const tx = await this.prisma.paymentTransaction.create({
      data: {
        orderId, amcSubscriptionId, userId,
        amount, status: 'PENDING', gateway: 'RAZORPAY',
        gatewayOrderId: rzpOrder.id,
      },
    });

    return {
      gatewayOrderId: rzpOrder.id,
      amount, currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      txId: tx.id,
    };
  }

  async verifyAndMarkPaid(gatewayOrderId: string, paymentId: string, signature: string): Promise<boolean> {
    if (!process.env.RAZORPAY_KEY_SECRET) throw new BadRequestException('Payment gateway not configured');
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${gatewayOrderId}|${paymentId}`)
      .digest('hex');
    if (expected !== signature) return false;

    // Persist verification so the confirm endpoint can trust it was legitimately paid
    const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId } });
    if (tx && tx.status !== 'PAID') {
      await this.prisma.paymentTransaction.update({
        where: { id: tx.id },
        data: { status: 'PAID', gatewayPaymentId: paymentId, gatewaySignature: signature },
      });
    }
    return true;
  }

  /** Webhook handler — verifies HMAC, auto-confirms linked order/subscription */
  async handleWebhook(rawBody: string, signature: string) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
      .update(rawBody)
      .digest('hex');
    if (expected !== signature) throw new BadRequestException('Invalid webhook signature');

    const event = JSON.parse(rawBody);
    this.logger.log(`Webhook received: ${event.event}`);

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const tx = await this.prisma.paymentTransaction.findFirst({
        where: { gatewayOrderId: payment.order_id },
      });
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
      const tx = await this.prisma.paymentTransaction.findFirst({
        where: { gatewayOrderId: payment.order_id },
      });
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
    const keyId = process.env.RAZORPAY_KEY_ID || '';
    const isLive = keyId.startsWith('rzp_live_');
    const isConfigured = !!this.razorpay;
    return { keyId, isLive, isConfigured, currency: 'INR' };
  }
}

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

  // Public — HMAC verification is the proof of authentic payment, no auth token needed
  @Public() @Post('verify')
  async verify(@Body() b: { orderId: string; paymentId: string; signature: string }) {
    const valid = await this.p.verifyAndMarkPaid(b.orderId, b.paymentId, b.signature);
    return { valid };
  }

  @Public() @Post('webhook')
  webhook(
    @Headers('x-razorpay-signature') signature: string,
    @Req() req: RawBodyRequest<any>,
  ) {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    return this.p.handleWebhook(rawBody, signature);
  }
}

@Module({ controllers: [PaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
