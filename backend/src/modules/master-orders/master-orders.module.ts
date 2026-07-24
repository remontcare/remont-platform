import {
  Module, Injectable, Controller, Get, Param, UseGuards, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { BookingChannel, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '../../common';

// ─── Service ───
//
// The customer-facing order wrapper (Phase 2 of the Master/Child order
// initiative — see architecture report). Existing `Order` rows/APIs are
// untouched; this is purely additive scaffolding. The split engine that
// actually populates `childOrders` from a checkout lands in a later phase —
// today `create()` is an internal primitive with no public endpoint yet,
// since a bare Master Order with no children isn't something a client
// should be able to produce directly until that engine exists.
@Injectable()
export class MasterOrdersService {
  constructor(private prisma: PrismaService) {}

  // RM + YYMMDD + 3-digit daily sequence, e.g. RM250724001.
  async generateMasterOrderNumber(): Promise<string> {
    const now = new Date();
    const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const countToday = await this.prisma.masterOrder.count({ where: { createdAt: { gte: startOfDay } } });
    const seq = String(countToday + 1).padStart(3, '0');
    return `RM${ymd}${seq}`;
  }

  async create(data: {
    customerId: string;
    addressId?: string;
    channel?: BookingChannel;
    guestName?: string;
    guestPhone?: string;
    guestEmail?: string;
  }) {
    const masterOrderNumber = await this.generateMasterOrderNumber();
    return this.prisma.masterOrder.create({
      data: {
        masterOrderNumber,
        customerId: data.customerId,
        addressId: data.addressId,
        channel: data.channel || BookingChannel.WEBSITE,
        guestName: data.guestName,
        guestPhone: data.guestPhone,
        guestEmail: data.guestEmail,
      },
    });
  }

  async findMine(customerId: string) {
    return this.prisma.masterOrder.findMany({
      where: { customerId },
      include: {
        address: true,
        childOrders: { include: { service: true, items: { include: { product: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, requesterId: string, requesterRole: UserRole) {
    const mo = await this.prisma.masterOrder.findUnique({
      where: { id },
      include: {
        address: true,
        customer: { select: { name: true, phone: true } },
        childOrders: {
          include: { service: true, vendor: true, items: { include: { product: true } }, invoice: true },
        },
      },
    });
    if (!mo) throw new NotFoundException('Master order not found');
    const isOwner = mo.customerId === requesterId;
    const isStaff = requesterRole === UserRole.ADMIN || requesterRole === UserRole.SUPER_ADMIN;
    if (!isOwner && !isStaff) throw new ForbiddenException();
    return mo;
  }

  async adminList(opts: { status?: string; q?: string; limit?: number; offset?: number }) {
    return this.prisma.masterOrder.findMany({
      where: {
        ...(opts.status ? { status: opts.status as any } : {}),
        ...(opts.q ? {
          OR: [
            { masterOrderNumber: { contains: opts.q, mode: 'insensitive' as const } },
            { customer: { name: { contains: opts.q, mode: 'insensitive' as const } } },
            { customer: { phone: { contains: opts.q } } },
          ],
        } : {}),
      },
      include: {
        customer: { select: { name: true, phone: true } },
        childOrders: { select: { id: true, orderNumber: true, type: true, status: true, totalAmount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit || 50,
      skip: opts.offset || 0,
    });
  }

  async adminGetById(id: string) {
    const mo = await this.prisma.masterOrder.findUnique({
      where: { id },
      include: {
        address: true,
        customer: { select: { name: true, phone: true } },
        childOrders: {
          include: { service: true, vendor: true, items: { include: { product: true } }, invoice: true },
        },
      },
    });
    if (!mo) throw new NotFoundException('Master order not found');
    return mo;
  }
}

// ─── Controller (customer-facing) ───
@ApiTags('Master Orders')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('master-orders')
export class MasterOrdersController {
  constructor(private masterOrders: MasterOrdersService) {}

  @Get('mine')
  mine(@CurrentUser() u: JwtPayload) { return this.masterOrders.findMine(u.sub); }

  @Get(':id')
  detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.masterOrders.findById(id, u.sub, u.role);
  }
}

// ─── Module ───
@Module({
  controllers: [MasterOrdersController],
  providers: [MasterOrdersService],
  exports: [MasterOrdersService],
})
export class MasterOrdersModule {}
