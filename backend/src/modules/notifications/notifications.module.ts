import { Module, Injectable, Controller, Get, Patch, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '../../common';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, data: {
    title: string;
    body: string;
    channels: NotificationChannel[];
    iconUrl?: string;
    actionUrl?: string;
    orderId?: string;
  }) {
    return this.prisma.notification.create({ data: { ...data, userId } });
  }

  async list(userId: string, limit = 30) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }
}

@ApiTags('Notifications')
@ApiBearerAuth() @UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notif: NotificationsService) {}
  @Get() list(@CurrentUser() u: JwtPayload) { return this.notif.list(u.sub); }
  @Get('unread-count') count(@CurrentUser() u: JwtPayload) { return this.notif.unreadCount(u.sub); }
  @Patch(':id/read') read(@CurrentUser() u: JwtPayload, @Param('id') id: string) { return this.notif.markRead(u.sub, id); }
  @Patch('read-all') readAll(@CurrentUser() u: JwtPayload) { return this.notif.markAllRead(u.sub); }
}

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
