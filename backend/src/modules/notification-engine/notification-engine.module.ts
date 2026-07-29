import { Module, Controller, Post, Delete, Patch, Get, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DevicePlatform } from '@prisma/client';
import { IsString, IsEnum, IsOptional, IsIn } from 'class-validator';
import { JwtAuthGuard, CurrentUser, JwtPayload, Public } from '../../common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AuthModule } from '../auth/auth.module';

import { FcmService } from './fcm.service';
import { NotificationGateway } from './notification.gateway';
import { ChannelAdapters } from './channel-adapters';
import { NotificationEngineService } from './notification-engine.service';
import { RetrySweepService } from './retry-sweep.service';
import { JobRingPolicyService } from './job-ring-policy.service';
import { ScheduledNotificationCron } from './scheduled-notification.cron';

class RegisterDeviceDto {
  @IsString() token: string;
  @IsEnum(DevicePlatform) platform: DevicePlatform;
  @IsOptional() @IsString() userAgent?: string;
}

class UnregisterDeviceDto {
  @IsString() token: string;
}

class AckDeliveryDto {
  @IsIn(['DELIVERED', 'OPENED']) event: 'DELIVERED' | 'OPENED';
}

@ApiTags('Notification Engine')
@Controller('notifications')
export class NotificationEngineController {
  constructor(private engine: NotificationEngineService) {}

  // Public, non-secret Firebase Web SDK config — same pattern as PaymentsController.config()
  // exposing Razorpay's public keyId. Lets frontend/shared/remont-notifications.js init the
  // SDK without hardcoding any Firebase project details in a static HTML file.
  @Public() @Get('push-config')
  pushConfig() {
    return {
      configured: !!(process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID),
      apiKey: process.env.FIREBASE_API_KEY || null,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
      projectId: process.env.FIREBASE_PROJECT_ID || null,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
      appId: process.env.FIREBASE_APP_ID || null,
      vapidKey: process.env.FIREBASE_VAPID_KEY || null,
    };
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Post('devices')
  registerDevice(@CurrentUser() u: JwtPayload, @Body() dto: RegisterDeviceDto) {
    return this.engine.registerDevice(u.sub, dto.token, dto.platform, { userAgent: dto.userAgent });
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Delete('devices')
  unregisterDevice(@Body() dto: UnregisterDeviceDto) {
    return this.engine.unregisterDevice(dto.token);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Patch('deliveries/:id/ack')
  ack(@Param('id') id: string, @Body() dto: AckDeliveryDto) {
    return this.engine.ackDelivery(id, dto.event);
  }
}

@Module({
  imports: [PrismaModule, NotificationsModule, WhatsappModule, AuthModule],
  controllers: [NotificationEngineController],
  providers: [FcmService, NotificationGateway, ChannelAdapters, NotificationEngineService, RetrySweepService, JobRingPolicyService, ScheduledNotificationCron],
  exports: [NotificationEngineService],
})
export class NotificationEngineModule {}
