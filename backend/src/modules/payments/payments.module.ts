import { Module, Injectable, Controller, Post, Body, UseGuards, BadRequestException, Logger, Headers, Req } from '@nestjs/common';
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
    // Lazy-load Razorpay (only if credentials configured)
    if (process.env.RAZORPAY_KEY_ID) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Razorpay = require('razorpay');
        this.razorpay = new Razorpay({
          key_id: process.env.RAZORPAY_KEY_ID,
          key_secret: process.env.RAZORPAY_KEY_SECRET,
        });
      } catch (e) {
        this.logger.warn('Razorpay package not loaded. Run npm install.');
      }
    }
  }

  async createOrder(userId: string, amount: number, orderId?: string, amcSubscriptionId?: string) {
    if (!this.razorpay) {
      // DEV mode — return mock order
      const mockId = `order_dev_${Date.now()}`;
      const tx = await this.prisma.paymentTransaction.create({
        data: {
          orderId, amcSubscriptionId, userId,
          amount, status: 'PENDING', gateway: 'RAZORPAY_DEV',
          gatewayOrderId: mockId,
        },
      });
      return { gatewayOrderId: mockId, amount, currency: 'INR', keyId: 'dev', _devMock: true, txId: tx.id };
    }

    const rzpOrder = await this.razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
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

  /** Razorpay webhook handler — verifies signature, updates payment */
  async handleWebhook(rawBody: string, signature: string) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
      .update(rawBody)
      .digest('hex');
    if (expected !== signature) throw new BadRequestException('Invalid signature');

    const event = JSON.parse(rawBody);
    this.logger.log(`📥 Webhook: ${event.event}`);

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
        // Propagate to order/subscription
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
    return { received: true };
  }

  async verifyClientSidePayment(orderId: string, paymentId: string, signature: string) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    if (expected !== signature) return { valid: false };
    return { valid: true };
  }
}

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private p: PaymentsService) {}

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('create-order')
  create(@CurrentUser() u: JwtPayload, @Body() b: { amount: number; orderId?: string; amcSubscriptionId?: string }) {
    return this.p.createOrder(u.sub, b.amount, b.orderId, b.amcSubscriptionId);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('verify')
  verify(@Body() b: { orderId: string; paymentId: string; signature: string }) {
    return this.p.verifyClientSidePayment(b.orderId, b.paymentId, b.signature);
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
