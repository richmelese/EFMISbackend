import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Farmer } from '../farmers/entities/farmer.entity';
import { Region } from '../admin-units/entities/region.entity';
import { DemandDocument } from '../national/entities/demand-document.entities';
import { PurchaseOrder, QuotaAdjustmentRequest, QuotaAllocation, QuotaLetter } from '../quota/entities/quota.entities';
import { FarmersModule } from '../farmers/farmers.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LogisticsDashboardModule } from '../logistics/dashboard/dashboard.module';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

/** /meta, /bootstrap, /dashboard, /dashboard/overview, /copilot/ask */
@Module({
  imports: [
    TypeOrmModule.forFeature([Farmer, Region, DemandDocument, QuotaAllocation, QuotaLetter, QuotaAdjustmentRequest, PurchaseOrder]),
    FarmersModule,
    IntegrationsModule,
    LogisticsDashboardModule
  ],
  controllers: [DashboardController],
  providers: [DashboardService]
})
export class DashboardModule {}
