import { Body, Controller, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { ReportsService } from './reports.service';
import { AddLotUnionDto, CreateLotDto, CreateReportDateDto, DailySummaryQuery, DispatchEntryDto, LotDateDto, UnionLoadDto, UpdateDailyRecordDto } from './dto/reports.dto';

@ApiTags('Daily Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  // ===================== Daily Fertilizer Summary =====================
  @Get('daily-summary/dates')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Report dates (Ethiopian calendar), latest flagged' })
  dates() {
    return this.svc.datesOut();
  }

  @Get('daily-summary/all')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Full structure { dates, recordsByDate }' })
  all(@CurrentUser() user: AuthUser) {
    return this.svc.all(user);
  }

  @Get('daily-summary/export')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Export a report date as CSV (?date=)' })
  async exportDaily(@Query('date') date: string | undefined, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext, @Res() res: Response) {
    const { filename, csv } = await this.svc.exportCsv(user, date, ctx);
    res.type('text/csv').attachment(filename).send(csv);
  }

  @Get('daily-summary')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Daily summary for a date (?date, regionId, fertilizerType, q) with grand totals and region groups' })
  summary(@Query() q: DailySummaryQuery, @CurrentUser() user: AuthUser) {
    return this.svc.summary(q, user);
  }

  @Put('daily-summary/:date/:regionId/:fertilizerType')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Edit a daily summary record' })
  update(@Param('date') date: string, @Param('regionId') regionId: string, @Param('fertilizerType') fertilizerType: string,
    @Body() dto: UpdateDailyRecordDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.updateRecord(user, date, regionId, fertilizerType, dto, ctx);
  }

  @Post('daily-summary/dates')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Open a new report date (carries over the previous date figures)' })
  openDate(@Body() dto: CreateReportDateDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.openDate(user, dto, ctx);
  }

  // ===================== Regional Vessel Dispatch & Union Loading =====================
  @Get('regional/regions')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Report regions' })
  regions(@CurrentUser() user: AuthUser) {
    return this.svc.regions(user);
  }

  @Get('regional/lots')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Vessel lots: { regionId: [lots] } or one region with ?regionId=' })
  lots(@CurrentUser() user: AuthUser, @Query('regionId') regionId?: string) {
    return this.svc.listLots(user, regionId);
  }

  @Post('regional/lots')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Create a vessel lot for a region' })
  createLot(@Body() dto: CreateLotDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.createLot(user, dto, ctx);
  }

  @Patch('regional/lots/:lotId/unions/:unionId/loads')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Set the loaded quantity for a union on a date (inline cell edit); unionId may be short ("u1") or full' })
  setLoad(@Param('lotId') lotId: string, @Param('unionId') unionId: string, @Body() dto: UnionLoadDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.setUnionLoad(user, lotId, unionId, dto, ctx);
  }

  @Post('regional/lots/:lotId/dispatches')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Add a dispatch loading entry with waybill (waybill unique; warns when exceeding union share)' })
  dispatch(@Param('lotId') lotId: string, @Body() dto: DispatchEntryDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.addDispatch(user, lotId, dto, ctx);
  }

  @Get('regional/lots/:lotId/dispatches')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Waybills recorded for a lot' })
  dispatches(@Param('lotId') lotId: string, @CurrentUser() user: AuthUser) {
    return this.svc.dispatches(user, lotId);
  }

  @Post('regional/lots/:lotId/dates')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Add a loading date column to a lot' })
  addDate(@Param('lotId') lotId: string, @Body() dto: LotDateDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.addDate(user, lotId, dto, ctx);
  }

  @Post('regional/lots/:lotId/unions')
  @RequirePermissions('reports:edit')
  @ApiOperation({ summary: 'Add a union quota line to a lot' })
  addUnion(@Param('lotId') lotId: string, @Body() dto: AddLotUnionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.addUnion(user, lotId, dto, ctx);
  }

  @Get('regional/export')
  @RequirePermissions('reports:read')
  @ApiOperation({ summary: 'Export a region dispatch sheet as CSV (?regionId= required)' })
  async exportRegional(@Query('regionId') regionId: string | undefined, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext, @Res() res: Response) {
    const { filename, csv } = await this.svc.regionalExport(user, regionId, ctx);
    res.type('text/csv').attachment(filename).send(csv);
  }
}
