import { Body, Controller, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { paginate } from '../../common/utils/helpers';
import { IntegrationsService } from './integrations.service';
import { EcxPriceDto, QualityInspectionDto, TenderFeedDto, TruckPingDto, VesselFeedDto, WarehouseFeedDto } from './dto/integrations.dto';

@ApiTags('Integrations (REQ-INT-001..004)')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  // ---------------- REQ-INT-001 Procurement ----------------
  @Get('procurement')
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'EABC procurement status: tenders, vessels, purchase orders (REQ-INT-001)' })
  procurement() {
    return this.svc.procurement();
  }

  @Put('procurement/tenders/:tenderNo')
  @RequirePermissions('integrations:write')
  @ApiOperation({ summary: 'Inbound tender / LC / forex feed from EABC Procure (upsert; overdue deadline raises HIGH alert)' })
  tender(@Param('tenderNo') tenderNo: string, @Body() dto: TenderFeedDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.upsertTender(user, tenderNo, dto, ctx);
  }

  @Put('procurement/vessels/:imo')
  @RequirePermissions('integrations:write')
  @ApiOperation({ summary: 'Inbound vessel tracking feed (upsert; HIGH demurrage risk raises alert)' })
  vessel(@Param('imo') imo: string, @Body() dto: VesselFeedDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.upsertVessel(user, imo, dto, ctx);
  }

  // ---------------- REQ-INT-002 Quality ----------------
  @Get('quality')
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'ECAE quality compliance dashboard (REQ-INT-002)' })
  quality() {
    return this.svc.quality();
  }

  @Get('quality/coc/:code/verify')
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'Verify a Certificate of Conformity by CoC number or QR verification code' })
  async verifyCoc(@Param('code') code: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.verifyCoc(code);
    if (!r) {
      res.status(404);
      return { valid: false, message: 'Certificate of Conformity not found' };
    }
    return r;
  }

  @Post('quality/inspections')
  @RequirePermissions('integrations:write')
  @ApiOperation({ summary: 'ECAE lab result feed (extra lab parameters are stored as received); REJECTED_IMPOUNDED raises a CRITICAL alert' })
  inspection(@Body() dto: QualityInspectionDto, @Req() req: Request, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    // The global ValidationPipe whitelists DTO properties; keep the product-specific lab fields from the raw body (passthrough).
    const raw = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    return this.svc.recordInspection(user, { ...raw, ...dto }, ctx);
  }

  // ---------------- REQ-INT-003 Logistics ----------------
  @Get('logistics')
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'Logistics status: GPS fleet (page/pageSize), bottlenecks, warehouse utilisation (REQ-INT-003)' })
  logistics(@CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.svc.logistics(user, items => paginate(req, res, items));
  }

  @Put('logistics/trucks/:truckId')
  @RequirePermissions('integrations:write')
  @ApiOperation({ summary: 'GPS platform ping (stationary >= 3 h raises a theft/diversion alert)' })
  truck(@Param('truckId') truckId: string, @Body() dto: TruckPingDto) {
    return this.svc.truckPing(truckId, dto);
  }

  @Put('logistics/warehouses/:name')
  @RequirePermissions('integrations:write')
  @ApiOperation({ summary: 'Warehouse stock feed (>= 80% capacity raises HIGH alert)' })
  warehouse(@Param('name') name: string, @Body() dto: WarehouseFeedDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.warehouseFeed(user, name, dto, ctx);
  }

  // ---------------- REQ-INT-004 Financials ----------------
  @Get('financials')
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'Farmer sales, repayment and ECX prices (REQ-INT-004)' })
  financials(@CurrentUser() user: AuthUser) {
    return this.svc.financials(user);
  }

  @Put('financials/ecx-prices/:commodity')
  @RequirePermissions('integrations:write')
  @ApiOperation({ summary: 'ECX market price feed (>= 10% move raises MEDIUM alert)' })
  ecx(@Param('commodity') commodity: string, @Body() dto: EcxPriceDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.ecxPrice(user, commodity, dto, ctx);
  }
}
