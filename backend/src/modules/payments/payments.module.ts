import {
  Module, Injectable, Controller, Get, Post, Query, Body, UseGuards, ForbiddenException,
  BadRequestException, Logger, Headers, Req, OnModuleInit,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload, VENDOR_WALLET_TOPUP_MARKER, Roles, RolesGuard } from '../../common';
import { UserRole } from '@prisma/client';

/**
 * Razorpay reports its charge on a captured payment as `fee` (paise, INCLUDING GST) and `tax`
 * (the GST part). Stored in rupees as the net fee and its GST separately — the GST is input tax.
 * Empty when the payment carries no fee information (never guessed).
 */
export function gatewayFeeFromPayment(payment: any): { gatewayFee?: number; gatewayFeeTax?: number } {
  if (!payment || payment.fee == null || Number.isNaN(Number(payment.fee))) return {};
  const fee = Number(payment.fee) / 100;
  const tax = payment.tax != null && !Number.isNaN(Number(payment.tax)) ? Number(payment.tax) / 100 : 0;
  return { gatewayFee: Math.round((fee - tax) * 100) / 100, gatewayFeeTax: Math.round(tax * 100) / 100 };
}
import { PaymentNotificationsService, PaymentNotificationsModule } from '../payment-notifications/payment-notifications.module';

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

  constructor(private prisma: PrismaService, private paymentNotify: PaymentNotificationsService, private events: EventEmitter2) {
    // Bootstrap from env vars — will be overridden by DB in onModuleInit
    this.razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
    this.razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || '';
    this.razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (this.razorpayKeyId && this.razorpayKeySecret) {
      this._initRazorpay(this.razorpayKeyId, this.razorpayKeySecret);
    }
  }

  async onModuleInit() {
    // DB keys override env vars — lets admin change keys without redeploying. Swallow
    // failures here (e.g. DB unreachable at boot): PrismaService already degrades
    // gracefully in that case, but this query is NOT wrapped by that guard, and an
    // unhandled rejection here previously crashed the entire Nest bootstrap — env-var
    // based init from the constructor is a perfectly good fallback until the DB is up.
    try {
      await this.reinitialize();
    } catch (e) {
      this.logger.warn(`Gateway config reinitialize failed (DB unreachable?): ${e.message}`);
    }
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
      data: { orderId, masterOrderId: await this.masterOrderIdFor(orderId), amcSubscriptionId, userId, amount, status: 'PENDING', gateway: 'RAZORPAY', gatewayOrderId: rzpOrder.id },
    });
    return { gateway: 'RAZORPAY', gatewayOrderId: rzpOrder.id, amount, currency: 'INR', keyId: this.razorpayKeyId, txId: tx.id };
  }

  /** Legacy alias used by AMC and retry-payment flows */
  /** A cart (MasterOrder) payment also records masterOrderId, so every reader can find it. */
  private async masterOrderIdFor(orderId?: string | null): Promise<string | undefined> {
    if (!orderId) return undefined;
    const mo = await this.prisma.masterOrder.findUnique({ where: { id: orderId }, select: { id: true } });
    return mo?.id;
  }

  async createOrder(userId: string, amount: number, orderId?: string, amcSubscriptionId?: string) {
    // Ownership: a client-created payment may only be attached to the caller's own order/cart/AMC
    // (top-up markers are the caller's own wallet by definition).
    if (orderId && orderId !== 'WALLET_TOPUP' && orderId !== VENDOR_WALLET_TOPUP_MARKER) {
      const [o, mo] = await Promise.all([
        this.prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } }),
        this.prisma.masterOrder.findUnique({ where: { id: orderId }, select: { customerId: true } }),
      ]);
      const owner = o?.customerId ?? mo?.customerId;
      if (!owner) throw new BadRequestException('Unknown order');
      if (owner !== userId) throw new ForbiddenException();
    }
    if (amcSubscriptionId) {
      const sub = await this.prisma.amcSubscription.findUnique({ where: { id: amcSubscriptionId }, select: { userId: true } });
      if (!sub) throw new BadRequestException('Unknown subscription');
      if (sub.userId !== userId) throw new ForbiddenException();
    }
    return this.createRazorpayOrder(userId, amount, orderId, amcSubscriptionId);
  }

  /**
   * Real UPI/QR for in-person cash collection — a Razorpay Payment Link for the exact
   * amount, whose short_url the partner app renders as a scannable QR so a customer can
   * actually pay via UPI on the spot instead of the vendor only trusting an unverified
   * "collected" tap. Returns null (rather than throwing) if Razorpay isn't configured or
   * link creation fails, so collectBalance()'s existing cash-collection flow is never
   * blocked by this being unavailable — it's an additive enhancement, not a requirement.
   */
  async createPaymentLink(amount: number, orderId: string): Promise<string | null> {
    if (!this.razorpay) return null;
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { orderNumber: true, customer: { select: { name: true, phone: true } } },
      });
      const link = await this.razorpay.paymentLink.create({
        amount: Math.round(amount * 100),
        currency: 'INR',
        accept_partial: false,
        description: `Remont order #${order?.orderNumber || orderId}`,
        customer: order?.customer ? { name: order.customer.name, contact: order.customer.phone } : undefined,
        notify: { sms: false, email: false },
        notes: { orderId },
      });
      return link.short_url as string;
    } catch (e) {
      this.logger.warn(`Payment link creation failed for order ${orderId}: ${e.message}`);
      return null;
    }
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

  /**
   * PAYMENT SECURITY — re-derives the amount Razorpay actually captured for one specific
   * payment, straight from Razorpay's own record, rather than trusting anything stored
   * locally. A valid HMAC signature only proves *a* payment happened for the given
   * (gatewayOrderId, paymentId) pair — it says nothing about whether that payment covers
   * what a particular order/master-order actually costs. Callers (OrdersService /
   * MasterOrdersService confirmPayment) must compare this return value against their own
   * trusted, server-side required amount before marking anything paid.
   *
   * Deliberately does NOT read PaymentTransaction.amount (set at create-order time, and
   * historically the thing that made the underpayment bypass possible) — this always goes
   * back to the gateway itself.
   */
  /**
   * Admin backfill of gateway fees for captured Razorpay payments that have none recorded —
   * read-only fetches from Razorpay (no money moves), a bounded batch per call.
   */
  async backfillGatewayFees(limit = 50) {
    if (!this.razorpay) throw new BadRequestException('Payment gateway not configured');
    const rows = await this.prisma.paymentTransaction.findMany({
      where: { gateway: 'RAZORPAY', status: 'PAID', gatewayPaymentId: { not: null }, gatewayFee: null, refundRequestId: null },
      orderBy: { createdAt: 'asc' }, take: Math.min(Math.max(1, Number(limit) || 50), 200),
    });
    let updated = 0; const failed: { id: string; error: string }[] = []; let noFee = 0;
    for (const row of rows) {
      try {
        const payment: any = await this.razorpay.payments.fetch(row.gatewayPaymentId as string);
        const fee = gatewayFeeFromPayment(payment);
        if (fee.gatewayFee == null) { noFee++; continue; }
        await this.prisma.paymentTransaction.update({ where: { id: row.id }, data: fee });
        updated++;
      } catch (e: any) {
        failed.push({ id: row.id, error: String(e?.error?.description || e?.message || e).slice(0, 200) });
      }
    }
    const remaining = await this.prisma.paymentTransaction.count({
      where: { gateway: 'RAZORPAY', status: 'PAID', gatewayPaymentId: { not: null }, gatewayFee: null, refundRequestId: null },
    });
    return { checked: rows.length, updated, withoutFeeData: noFee, failed, remaining };
  }

  async getVerifiedCapturedAmount(gatewayOrderId: string, paymentId: string): Promise<number> {
    if (!this.razorpay) throw new BadRequestException('Payment gateway not configured');
    let payment: any;
    try {
      payment = await this.razorpay.payments.fetch(paymentId);
    } catch (e) {
      this.logger.warn(`Razorpay payment fetch failed for verification: ${e.message}`);
      throw new BadRequestException('Unable to verify payment with the gateway');
    }
    if (!payment || payment.order_id !== gatewayOrderId) {
      throw new BadRequestException('Payment does not match the expected gateway order');
    }
    if (payment.status !== 'captured') {
      throw new BadRequestException('Payment has not been captured by the gateway');
    }
    return Number(payment.amount) / 100;
  }

  /**
   * Real gateway money movement — previously refunds only ever flipped a status flag
   * (AdminService.refundOrder()) with nothing actually sent back to the customer's original
   * payment method. Called only from the admin-approved refund-decision pipeline
   * (RefundsService) — gateway refund is the exception path, wallet credit is the default,
   * per the business's refund policy. Test-mode Razorpay keys only move test money.
   */
  async refundPayment(paymentTransactionId: string, amount: number): Promise<{ refundId: string; gateway: string }> {
    const tx = await this.prisma.paymentTransaction.findUnique({ where: { id: paymentTransactionId } });
    if (!tx || tx.status !== 'PAID') throw new BadRequestException('Payment transaction not found or not marked PAID');
    if (amount <= 0 || amount > Number(tx.amount)) throw new BadRequestException('Invalid refund amount');

    if (tx.gateway === 'RAZORPAY') {
      if (!this.razorpay || !tx.gatewayPaymentId) throw new BadRequestException('Razorpay not configured or payment has no gateway reference');
      const refund = await this.razorpay.payments.refund(tx.gatewayPaymentId, { amount: Math.round(amount * 100) });
      return { refundId: refund.id, gateway: 'RAZORPAY' };
    }
    if (tx.gateway === 'PHONEPE') {
      return this.refundPhonePe(tx.gatewayOrderId!, amount);
    }
    throw new BadRequestException(`Cannot issue a gateway refund for a ${tx.gateway} payment — use Wallet Credit instead`);
  }

  // ─── Duplicate-safe gateway refunds (used by RefundsService's provider-refund workflow) ───
  //
  // Razorpay idempotent refunds: POST /v1/payments/{id}/refund with the X-Refund-Idempotency
  // header (≥10 chars, [A-Za-z0-9_-]). A retry MUST reuse the same key and the same body; the
  // same key with a different body is rejected (409), a concurrent same-key request returns 409
  // "still in progress". The razorpay SDK (2.9.x) cannot send per-request headers, so this call
  // uses the REST endpoint directly with the same credentials. Every non-success outcome is
  // classified so the caller never assumes a refund did — or did not — happen when it is unsure.
  async createRazorpayRefund(
    gatewayPaymentId: string, amountPaise: number, idempotencyKey: string, receipt: string, notes: Record<string, string>,
  ): Promise<
    | { ok: true; refund: { id: string; status: string; amount: number; receipt?: string } }
    | { ok: false; kind: 'DEFINITE_REJECTION' | 'UNCERTAIN' | 'IN_PROGRESS' | 'KEY_CONFLICT'; httpStatus?: number; message: string }
  > {
    if (!this.razorpayKeyId || !this.razorpayKeySecret) return { ok: false, kind: 'DEFINITE_REJECTION', message: 'Razorpay is not configured' };
    if (!/^[A-Za-z0-9_-]{10,}$/.test(idempotencyKey)) return { ok: false, kind: 'DEFINITE_REJECTION', message: 'Invalid idempotency key' };
    let resp: any;
    try {
      resp = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(gatewayPaymentId)}/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(`${this.razorpayKeyId}:${this.razorpayKeySecret}`).toString('base64'),
          'X-Refund-Idempotency': idempotencyKey,
        },
        body: JSON.stringify({ amount: amountPaise, receipt, notes }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      // Timeout / network failure: the request may or may not have reached Razorpay.
      return { ok: false, kind: 'UNCERTAIN', message: `No response from Razorpay: ${e?.message || e}` };
    }
    let body: any = null;
    try { body = await resp.json(); } catch { body = null; }
    if (resp.ok && body?.id) return { ok: true, refund: { id: body.id, status: body.status, amount: body.amount, receipt: body.receipt } };
    const message = String(body?.error?.description || body?.error?.reason || `HTTP ${resp.status}`);
    if (resp.status === 409) {
      return /in progress/i.test(message)
        ? { ok: false, kind: 'IN_PROGRESS', httpStatus: 409, message }
        : { ok: false, kind: 'KEY_CONFLICT', httpStatus: 409, message };
    }
    // "fully refunded already" can mean an earlier attempt DID go through — never treat as a clean rejection.
    if (resp.status >= 400 && resp.status < 500 && !/fully refunded/i.test(message)) {
      return { ok: false, kind: 'DEFINITE_REJECTION', httpStatus: resp.status, message };
    }
    return { ok: false, kind: 'UNCERTAIN', httpStatus: resp.status, message };
  }

  /** Current state of one Razorpay refund (null when Razorpay is not configured). */
  async fetchRazorpayRefund(gatewayPaymentId: string, refundId: string): Promise<{ id: string; status: string; amount: number; receipt?: string } | null> {
    if (!this.razorpay) return null;
    const r = await this.razorpay.payments.fetchRefund(gatewayPaymentId, refundId);
    return { id: r.id, status: r.status, amount: r.amount, receipt: r.receipt };
  }

  /** Finds the refund for our stable receipt / internal id among a payment's refunds (null = none found). */
  async findRazorpayRefundByReceipt(gatewayPaymentId: string, receipt: string): Promise<{ id: string; status: string; amount: number; receipt?: string } | null> {
    if (!this.razorpay) throw new BadRequestException('Razorpay is not configured');
    const list = await this.razorpay.payments.fetchMultipleRefund(gatewayPaymentId, { count: 100 });
    const match = (list?.items || []).find((r: any) => r.receipt === receipt || r?.notes?.internal_refund_id === receipt);
    return match ? { id: match.id, status: match.status, amount: match.amount, receipt: match.receipt } : null;
  }

  /** PhonePe refund with a caller-supplied, stable merchant refund id (no status API is wired here). */
  async submitPhonePeRefund(merchantTransactionId: string, amount: number, merchantRefundId: string) {
    return this.refundPhonePe(merchantTransactionId, amount, merchantRefundId);
  }

  private async refundPhonePe(merchantTransactionId: string, amount: number, stableRefundId?: string): Promise<{ refundId: string; gateway: string }> {
    const cfg = this.phonePe;
    if (!cfg.merchantId || !cfg.saltKey) throw new BadRequestException('PhonePe is not configured');
    const merchantRefundId = stableRefundId || `REFUND_${merchantTransactionId.slice(-8)}_${Date.now()}`;
    const payload = {
      merchantId: cfg.merchantId,
      merchantTransactionId: merchantRefundId,
      originalTransactionId: merchantTransactionId,
      amount: Math.round(amount * 100),
      callbackUrl: '',
    };
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const endpoint = '/pg/v1/refund';
    const signature = crypto.createHash('sha256')
      .update(base64Payload + endpoint + cfg.saltKey)
      .digest('hex') + '###' + cfg.saltIndex;
    const resp = await fetch(`${cfg.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VERIFY': signature, 'X-MERCHANT-ID': cfg.merchantId },
      body: JSON.stringify({ request: base64Payload }),
    });
    const data: any = await resp.json();
    if (!data.success) throw new BadRequestException(data.message || 'PhonePe refund failed');
    return { refundId: merchantRefundId, gateway: 'PHONEPE' };
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

  async handleWebhook(rawBody: string, signature: string, eventId?: string) {
    const secret = this.razorpayWebhookSecret;
    if (!secret) throw new BadRequestException('Webhook secret not configured');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (expected !== signature) throw new BadRequestException('Invalid webhook signature');

    const event = JSON.parse(rawBody);
    this.logger.log(`Webhook: ${event.event}`);

    // De-duplicate by Razorpay's event id (x-razorpay-event-id), AFTER the signature check. An
    // event is marked processed only once its handling succeeded, so a delivery that failed
    // half-way is processed again on Razorpay's retry; a successfully handled one is skipped.
    if (eventId) {
      const seen = await this.prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
      if (seen?.processedAt) return { received: true, duplicate: true };
      if (!seen) {
        try {
          await this.prisma.paymentWebhookEvent.create({ data: { provider: 'RAZORPAY', eventId, event: String(event.event || '') } });
        } catch {
          // a concurrent delivery of the same event inserted it first
          const again = await this.prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
          if (again?.processedAt) return { received: true, duplicate: true };
        }
      }
    }
    await this.handleWebhookEvent(event, signature);
    if (eventId) await this.prisma.paymentWebhookEvent.update({ where: { eventId }, data: { processedAt: new Date() } }).catch(() => {});
    return { received: true };
  }

  private async handleWebhookEvent(event: any, signature: string) {
    // Refund lifecycle → the refund workflow (RefundsService) — never marked complete on acceptance.
    if (typeof event.event === 'string' && event.event.startsWith('refund.')) {
      const refund = event.payload?.refund?.entity;
      if (refund?.id) {
        await this.events.emitAsync('provider.refund.update', {
          gateway: 'RAZORPAY', event: event.event, refundId: refund.id, paymentId: refund.payment_id,
          status: refund.status, amount: refund.amount, receipt: refund.receipt, internalRefundId: refund.notes?.internal_refund_id,
        });
      }
      return;
    }

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId: payment.order_id } });
      if (tx) {
        await this.prisma.paymentTransaction.update({
          where: { id: tx.id },
          data: { status: 'PAID', gatewayPaymentId: payment.id, gatewaySignature: signature, ...gatewayFeeFromPayment(payment) },
        });
        // Order / cart follow-up (confirm + dispatch for a first payment, balance + earnings for a
        // later one) is done by OrdersService / MasterOrdersService, which listen for this event and
        // apply the same verified, once-only logic as the browser callback.
        if (tx.orderId && !tx.isWalletTopup && tx.orderId !== VENDOR_WALLET_TOPUP_MARKER) {
          this.events.emit('payment.order.captured', { paymentTransactionId: tx.id, orderId: tx.orderId, gatewayPaymentId: payment.id });
        }
        if (tx.amcSubscriptionId) {
          const sub = await this.prisma.amcSubscription.findUnique({ where: { id: tx.amcSubscriptionId }, include: { plan: true } });
          if (sub && sub.status !== 'ACTIVE') {
            await this.prisma.amcSubscription.update({
              where: { id: tx.amcSubscriptionId },
              data: { paymentId: payment.id, status: 'ACTIVE', servicesRemaining: sub.plan.freeServicesCount },
            });
          }
        }
        // Wallet top-ups (customer or vendor) are credited by the explicit confirm-payment
        // call re-verifying the HMAC signature — but that call depends on the customer's own
        // browser round-tripping back to this server, which doesn't always happen (closed
        // tab, flaky network, killed app). This webhook is Razorpay's guaranteed-delivery
        // channel, so it must be able to trigger the same credit independently. Both listeners
        // (WalletService.onCustomerWalletTopupCaptured / WithdrawalService.
        // onVendorWalletTopupCaptured) guard the actual credit with an atomic claim on
        // PaymentTransaction.creditedAt, so emitting here even when the explicit confirm call
        // already credited is always a safe no-op, never a double-credit.
        if (tx.isWalletTopup) {
          this.events.emit('payment.customerWalletTopup.captured', {
            paymentTransactionId: tx.id, userId: tx.userId, amount: Number(tx.amount),
          });
        } else if (tx.orderId === VENDOR_WALLET_TOPUP_MARKER) {
          this.events.emit('payment.vendorWalletTopup.captured', {
            paymentTransactionId: tx.id, userId: tx.userId, amount: Number(tx.amount),
          });
        }
      }
    }

    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const failureReason = payment.error_description || payment.error_reason || undefined;
      const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId: payment.order_id } });
      if (tx) {
        await this.prisma.paymentTransaction.update({
          where: { id: tx.id },
          data: { status: 'FAILED', gatewayPaymentId: payment.id, failureReason },
        });
        if (tx.orderId && !tx.isWalletTopup) {
          this.notifyPaymentFailed(tx.userId, tx.orderId, failureReason).catch(() => {});
        }
      }
    }
  }

  private async notifyPaymentFailed(userId: string, orderId: string, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!user?.phone) return;
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
    const orderNumber = order?.orderNumber
      ?? (await this.prisma.masterOrder.findUnique({ where: { id: orderId }, select: { masterOrderNumber: true } }))?.masterOrderNumber;
    if (!orderNumber) return;
    await this.paymentNotify.paymentFailed(userId, user.phone, orderNumber, reason, orderId);
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
  webhook(@Headers('x-razorpay-signature') signature: string, @Headers('x-razorpay-event-id') eventId: string, @Req() req: RawBodyRequest<any>) {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    return this.p.handleWebhook(rawBody, signature, eventId || undefined);
  }
}

@ApiTags('Admin')
@ApiBearerAuth() @UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/payments')
export class PaymentsAdminController {
  constructor(private p: PaymentsService) {}
  @Post('gateway-fees/backfill') backfill(@Query('limit') limit?: string) { return this.p.backfillGatewayFees(limit ? Number(limit) : 50); }
}

@Module({
  imports: [PaymentNotificationsModule],
  controllers: [PaymentsController, PaymentsAdminController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
