import {
  Module, Injectable, Controller, Get, Post, Body, Param, UseGuards, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CorporateRole, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class CorporateService {
  constructor(private prisma: PrismaService) {}

  async createAccount(data: any) {
    const code = `CORP-${Date.now().toString().slice(-6)}`;
    return this.prisma.corporateAccount.create({ data: { ...data, companyCode: code } });
  }

  async addMember(userId: string, accountId: string, role: CorporateRole = CorporateRole.EMPLOYEE, department?: string) {
    return this.prisma.corporateMember.create({ data: { userId, accountId, role, department } });
  }

  async dashboard(userId: string) {
    const member = await this.prisma.corporateMember.findUnique({
      where: { userId },
      include: { account: true },
    });
    if (!member) throw new NotFoundException('Not a corporate member');

    const account = member.account;
    const memberIds = (await this.prisma.corporateMember.findMany({
      where: { accountId: account.id }, select: { userId: true },
    })).map((m) => m.userId);

    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);
    const [active, pending, mtd] = await Promise.all([
      this.prisma.order.count({
        where: { customerId: { in: memberIds }, status: { in: ['CONFIRMED', 'VENDOR_ASSIGNED', 'VENDOR_EN_ROUTE', 'STARTED', 'IN_PROGRESS'] } },
      }),
      this.prisma.order.count({ where: { customerId: { in: memberIds }, status: 'PENDING_PAYMENT' } }),
      this.prisma.order.aggregate({
        where: { customerId: { in: memberIds }, createdAt: { gte: som } },
        _sum: { totalAmount: true },
      }),
    ]);

    const recent = await this.prisma.order.findMany({
      where: { customerId: { in: memberIds } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { service: true, customer: { select: { name: true } } },
    });

    return {
      account, memberRole: member.role,
      stats: {
        activeOrders: active, pendingApproval: pending,
        mtdSpend: mtd._sum.totalAmount || 0,
        creditUsed: account.creditUsed,
        creditAvailable: Number(account.creditLimit) - Number(account.creditUsed),
      },
      recentOrders: recent,
    };
  }

  async approveOrder(approverId: string, orderId: string) {
    const member = await this.prisma.corporateMember.findUnique({ where: { userId: approverId } });
    if (!member || (member.role !== CorporateRole.MANAGER && member.role !== CorporateRole.ADMIN)) {
      throw new ForbiddenException('Only managers can approve');
    }
    return this.prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } });
  }
}

@ApiTags('Corporate')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('corporate')
export class CorporateController {
  constructor(private c: CorporateService) {}

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('accounts') create(@Body() b: any) { return this.c.createAccount(b); }

  @UseGuards(RolesGuard) @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('accounts/:id/members') member(@Param('id') id: string, @Body() b: { userId: string; role?: CorporateRole; department?: string }) {
    return this.c.addMember(b.userId, id, b.role, b.department);
  }

  @Get('dashboard') dash(@CurrentUser() u: JwtPayload) { return this.c.dashboard(u.sub); }
  @Post('orders/:id/approve') approve(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.c.approveOrder(u.sub, id);
  }
}

@Module({ controllers: [CorporateController], providers: [CorporateService], exports: [CorporateService] })
export class CorporateModule {}
