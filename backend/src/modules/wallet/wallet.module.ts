import {
  Module, Injectable, Controller, Get, Post, Body, Param, UseGuards, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CouponType, TransactionReason, TransactionType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, Public, CurrentUser, JwtPayload } from '../../common';

// ─── WALLET ───
@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}
  async balance(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } });
    return u?.walletBalance || 0;
  }
  async transactions(userId: string, limit = 30) {
    return this.prisma.walletTransaction.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
  }
  async credit(userId: string, amount: number, reason: TransactionReason, orderId?: string, notes?: string) {
    if (amount <= 0) throw new BadRequestException('Invalid amount');
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId }, data: { walletBalance: { increment: amount } },
        select: { walletBalance: true },
      });
      return tx.walletTransaction.create({
        data: { userId, type: TransactionType.CREDIT, reason, amount, balanceAfter: u.walletBalance, orderId, notes },
      });
    });
  }
  async debit(userId: string, amount: number, reason: TransactionReason, orderId?: string) {
    if (amount <= 0) throw new BadRequestException();
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id: userId } });
      if (!u || Number(u.walletBalance) < amount) throw new BadRequestException('Insufficient balance');
      const updated = await tx.user.update({
        where: { id: userId }, data: { walletBalance: { decrement: amount } },
        select: { walletBalance: true },
      });
      return tx.walletTransaction.create({
        data: { userId, type: TransactionType.DEBIT, reason, amount, balanceAfter: updated.walletBalance, orderId },
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
}

@Module({ controllers: [WalletController], providers: [WalletService], exports: [WalletService] })
export class WalletModule {}
