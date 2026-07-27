import {
  Module, Injectable, Controller, Get, Post, Body, Param, UseGuards, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CouponType, TransactionReason, TransactionType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public, CurrentUser, JwtPayload } from '../../common';
import { PaymentsService, PaymentsModule } from '../payments/payments.module';

// ─── WALLET ───
@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService, private payments: PaymentsService) {}
  async balance(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
    return u?.walletBalance || 0;
  }

  // "Add money" — reuses the existing Razorpay/PhonePe order-creation path with no linked
  // Order. Historically orderId stayed a loose, non-FK 'WALLET_TOPUP' marker (kept for
  // backward compat with any in-flight transactions); isWalletTopup is now the real,
  // unambiguous flag confirmTopup() (and reporting) key off going forward.
  async initiateTopup(userId: string, amount: number, frontendUrl: string) {
    if (!amount || amount <= 0) throw new BadRequestException('Enter a valid amount');
    const result: any = await this.payments.initiatePayment(userId, amount, 'WALLET_TOPUP', frontendUrl);
    const txId = result.txId || result.dbTxId;
    if (txId) await this.prisma.paymentTransaction.update({ where: { id: txId }, data: { isWalletTopup: true } });
    return result;
  }

  // Mirrors MasterOrdersService.confirmPayment()'s pattern: re-verify the HMAC ourselves
  // (via the existing gateway-secret-aware PaymentsService.verifyAndMarkPaid, which also
  // handles idempotent status updates), then credit the wallet once, not per retry.
  async confirmTopup(userId: string, paymentId: string, gatewayOrderId: string, signature: string) {
    const tx = await this.prisma.paymentTransaction.findFirst({ where: { gatewayOrderId, userId, isWalletTopup: true } });
    if (!tx) throw new BadRequestException('Top-up payment not found for this account');
    if (tx.status === 'PAID') return { walletBalance: await this.balance(userId) }; // idempotent

    const ok = await this.payments.verifyAndMarkPaid(gatewayOrderId, paymentId, signature);
    if (!ok) throw new BadRequestException('Invalid payment signature');

    await this.credit(userId, Number(tx.amount), TransactionReason.WALLET_TOPUP, undefined, 'Wallet top-up via Razorpay');
    return { walletBalance: await this.balance(userId) };
  }
  async transactions(userId: string, limit = 30) {
    return this.prisma.walletTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
  }
  async credit(
    userId: string, amount: number, reason: TransactionReason, orderId?: string, notes?: string,
    refundRequestId?: string, approvedBy?: string,
  ) {
    if (amount <= 0) throw new BadRequestException('Invalid amount');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId }, data: { walletBalance: { increment: amount } },
        select: { walletBalance: true },
      });
      return tx.walletTransaction.create({
        data: {
          userId, type: TransactionType.CREDIT, reason, amount, balanceAfter: u.walletBalance,
          orderId, notes, refundRequestId, approvedBy,
        },
      });
    });
  }
  async debit(
    userId: string, amount: number, reason: TransactionReason, orderId?: string,
    refundRequestId?: string, approvedBy?: string,
  ) {
    if (amount <= 0) throw new BadRequestException();
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId } });
      if (!u || Number(u.walletBalance) < amount) throw new BadRequestException('Insufficient balance');
      const updated = await tx.user.update({
        where: { id: userId }, data: { walletBalance: { decrement: amount } },
        select: { walletBalance: true },
      });
      return tx.walletTransaction.create({
        data: {
          userId, type: TransactionType.DEBIT, reason, amount, balanceAfter: updated.walletBalance,
          orderId, refundRequestId, approvedBy,
        },
      });
    });
  }
}

@ApiTags('Wallet')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private w: WalletService) {}
  @Get('balance') bal(@CurrentUser() u: JwtPayload) { return this.w.balance(u.sub); }
  @Get('transactions') tx(@CurrentUser() u: JwtPayload) { return this.w.transactions(u.sub); }

  @Post('add-money')
  addMoney(@CurrentUser() u: JwtPayload, @Body() b: { amount: number }) {
    const frontendUrl = process.env.FRONTEND_URL || 'https://remont.in';
    return this.w.initiateTopup(u.sub, b.amount, frontendUrl);
  }

  @Post('confirm-payment')
  confirmPayment(@CurrentUser() u: JwtPayload, @Body() b: { gatewayOrderId: string; paymentId: string; signature: string }) {
    return this.w.confirmTopup(u.sub, b.paymentId, b.gatewayOrderId, b.signature);
  }
}

@Module({
  imports: [PaymentsModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
