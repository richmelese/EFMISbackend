import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration, { AppConfig } from './config/configuration';
import { buildTypeOrmOptions } from './database/typeorm.config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { HealthController } from './health.controller';
import { SeedModule } from './database/seeds/seed.module';
import { DomainEventsModule } from './common/events';
// Platform (cross-cutting, @Global)
import { SettingsModule } from './modules/settings/settings.module';
import { AuditModule } from './modules/audit/audit.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { SignaturesModule } from './modules/signatures/signatures.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { CommentsModule } from './modules/comments/comments.module';
import { ExternalModule } from './modules/external/external.module';
import { SeasonsModule } from './modules/seasons/seasons.module';
import { AdminUnitsModule } from './modules/admin-units/admin-units.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { StorageModule } from './modules/storage/storage.module';
// Business domains (requirement sections)
import { FarmersModule } from './modules/farmers/farmers.module';
import { AggregationModule } from './modules/aggregation/aggregation.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { RegionalModule } from './modules/regional/regional.module';
import { NationalModule } from './modules/national/national.module';
import { QuotaModule } from './modules/quota/quota.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { ReportsModule } from './modules/reports/reports.module';
import { UssdModule } from './modules/ussd/ussd.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
// Logistics & Driver Management
import { LogisticsModule } from './modules/logistics/logistics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildTypeOrmOptions(config.get<AppConfig['db']>('db')!)
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    // platform
    DomainEventsModule, SettingsModule, AuditModule, UsersModule, AuthModule, SignaturesModule, NotificationsModule, AlertsModule,
    CommentsModule, ExternalModule, AdminUnitsModule, SeasonsModule, WorkflowModule, OutboxModule, StorageModule,
    // domains
    FarmersModule, AggregationModule, ReviewsModule, RegionalModule, NationalModule, QuotaModule,
    IntegrationsModule, ReportsModule, UssdModule, DashboardModule, SchedulerModule,
    LogisticsModule,
    SeedModule
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter }
  ]
})
export class AppModule {}
