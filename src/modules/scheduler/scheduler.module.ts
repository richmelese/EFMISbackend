import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Farmer } from '../farmers/entities/farmer.entity';
import { DemandDocument, DocumentSignature } from '../national/entities/demand-document.entities';
import { PurchaseOrder, QuotaLetter } from '../quota/entities/quota.entities';
import { SchedulerService } from './scheduler.service';
import { SchedulerController } from './scheduler.controller';

/** Hourly workflow job (enabled by SCHEDULER_ENABLED) + manual trigger POST /api/scheduler/run. */
@Module({
  imports: [TypeOrmModule.forFeature([Farmer, DemandDocument, DocumentSignature, QuotaLetter, PurchaseOrder])],
  controllers: [SchedulerController],
  providers: [SchedulerService],
  exports: [SchedulerService]
})
export class SchedulerModule {}
