import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { RequirePermissions } from '../../../common/decorators';
import { Granularity, LogisticsDashboardService } from './logistics-dashboard.service';

class ReportPeriodDto {
  @ApiPropertyOptional({ description: 'ISO 8601 (default: 30 days before `to`)' }) @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional({ description: 'ISO 8601 (default: now)' }) @IsOptional() @IsISO8601() to?: string;
}

class TripsReportDto extends ReportPeriodDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' }) @IsOptional() @IsIn(['day', 'week', 'month']) groupBy?: Granularity;
}

class StockDiscrepancyReportDto extends ReportPeriodDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}

@ApiTags('Logistics · Dashboard & reports')
@ApiBearerAuth()
@Controller({ version: '1' })
@RequirePermissions('logistics:reports')
export class LogisticsDashboardController {
  constructor(private readonly svc: LogisticsDashboardService) {}

  @Get('dashboard/summary')
  @ApiOperation({ summary: 'Operations Control Tower KPIs: trucks, GPS connectivity, trips, shipments, on-time rate, drivers, alerts, warehouses' })
  summary() {
    return this.svc.summary();
  }

  @Get('reports/trips')
  @ApiOperation({ summary: 'Trip completion & delivery timeliness per period (from/to, groupBy day|week|month)' })
  trips(@Query() q: TripsReportDto) {
    return this.svc.tripsReport(this.svc.period(q.from, q.to), q.groupBy || 'day');
  }

  @Get('reports/utilization')
  @ApiOperation({ summary: 'Truck utilisation % (time on trip / period)' })
  utilization(@Query() q: ReportPeriodDto) {
    return this.svc.utilizationReport(this.svc.period(q.from, q.to));
  }

  @Get('reports/gps-uptime')
  @ApiOperation({ summary: 'GPS uptime per device (% of hours with ≥ 1 position)' })
  gpsUptime(@Query() q: ReportPeriodDto) {
    return this.svc.gpsUptimeReport(this.svc.period(q.from, q.to));
  }

  @Get('reports/stock-discrepancies')
  @ApiOperation({ summary: 'Loading discrepancies, damage, adjustments (ledger) and delivery shortages' })
  stockDiscrepancies(@Query() q: StockDiscrepancyReportDto) {
    return this.svc.stockDiscrepancyReport(this.svc.period(q.from, q.to), q.warehouseId);
  }
}
