import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CitiesModule } from './modules/cities/cities.module';
import { ServicesModule } from './modules/services/services.module';
import { ProductsModule } from './modules/products/products.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { OrdersModule } from './modules/orders/orders.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { CorporateModule } from './modules/corporate/corporate.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CrmModule } from './modules/crm/crm.module';
import { AmcModule } from './modules/amc/amc.module';
import { AiAgentModule } from './modules/ai-agent/ai-agent.module';
import { AdminModule } from './modules/admin/admin.module';
import { CmsModule } from './modules/cms/cms.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { HealthModule } from './modules/health/health.module';
import { LocationModule } from './modules/location/location.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),

    PrismaModule,

    // Identity & Master Data
    AuthModule,
    UsersModule,
    CitiesModule,

    // Catalog
    ServicesModule,
    ProductsModule,

    // Operations
    VendorsModule,
    DeliveryModule,
    OrdersModule,
    InvoicesModule,

    // Wallet & Pricing
    WalletModule,
    CouponsModule,
    MembershipsModule,

    // B2B
    CorporateModule,

    // Communication
    WhatsappModule,
    NotificationsModule,
    PaymentsModule,

    // Strategic modules
    CrmModule,
    AmcModule,
    AiAgentModule,

    AdminModule,
    CmsModule,
    ReviewsModule,
    HealthModule,
    LocationModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
