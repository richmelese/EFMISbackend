import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailySummaryDate, DailySummaryRecord, DispatchWaybill, LotUnion, ReportRegion, UnionDailyLoad, VesselLot } from './entities/report.entities';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';

/** Daily operational reports: Daily Fertilizer Summary and Regional Vessel Dispatch & Union Loading. */
@Module({
  imports: [TypeOrmModule.forFeature([DailySummaryDate, DailySummaryRecord, ReportRegion, VesselLot, LotUnion, UnionDailyLoad, DispatchWaybill])],
  controllers: [ReportsController],
  providers: [ReportsService]
})
export class ReportsModule {}
