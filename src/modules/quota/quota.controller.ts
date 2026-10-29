import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { SignatureDto } from '../../common/dto/signature.dto';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { paginate } from '../../common/utils/helpers';
import { QuotaRunsService } from './quota-runs.service';
import { QuotaService } from './quota.service';
import { QuotaLettersService } from './quota-letters.service';
import {
  AdjustmentDecisionDto, AmendmentDecisionDto, AppealDto, CreateAdjustmentRequestDto, CreateAmendmentDto, CreateChildAllocationDto,
  CreateLettersDto, CreateProcurementRequestDto, CreateQuotaRunDto, DeliveryUpdateDto, ProcurementStatusDto, UpdateQuotaWeightsDto
} from './dto/quota.dto';

/**
 * Quota allocation (REQ-1.4-001..010). Route order matters: static segments (runs/compare, allocations/downward,
 * my-allocation, adjustment-requests/stats) are declared before their ":id" siblings.
 */
@ApiTags('Quota Allocation (REQ-1.4)')
@ApiBearerAuth()
@Controller('quota')
export class QuotaController {
  constructor(
    private readonly runs: QuotaRunsService,
    private readonly quota: QuotaService,
    private readonly letters: QuotaLettersService
  ) {}

  // ---------------- Provisional quotas (REQ-1.4-001) ----------------
  @Get('weights')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Saved quota factor weights' })
  weights() {
    return this.runs.getWeights();
  }

  @Put('weights')
  @RequirePermissions('quota:generate')
  @ApiOperation({ summary: 'Change quota factor weights (must sum to 100; audited with justification)' })
  updateWeights(@Body() dto: UpdateQuotaWeightsDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.updateWeights(user, dto, ctx);
  }

  @Get('provisional')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Live provisional quota preview (EFMIS-QA-1.0) with factor breakdown per region' })
  @ApiQuery({ name: 'historical', required: false }) @ApiQuery({ name: 'soilIndex', required: false })
  @ApiQuery({ name: 'arrearsPenalty', required: false }) @ApiQuery({ name: 'totalMT', required: false })
  provisional(@Query() q: Record<string, unknown>) {
    return this.runs.provisional(q);
  }

  @Get('regions')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Current regional quota table' })
  async regions(@CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return paginate(req, res, await this.runs.regionTable(user));
  }

  @Post('runs')
  @RequirePermissions('quota:generate')
  @ApiOperation({ summary: 'Compute and store a provisional quota run (or scenario)' })
  createRun(@Body() dto: CreateQuotaRunDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.createRun(user, dto, ctx);
  }

  @Get('runs')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Quota runs (newest first)' })
  listRuns() {
    return this.runs.listRuns();
  }

  @Get('runs/compare')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Compare runs side by side (?ids=RUN1,RUN2)' })
  compareRuns(@Query('ids') ids?: string) {
    return this.runs.compareRuns(ids);
  }

  @Get('runs/:id')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Quota run detail' })
  getRun(@Param('id') id: string) {
    return this.runs.getRun(id);
  }

  @Post('runs/:id/publish')
  @HttpCode(200)
  @RequirePermissions('quota:generate')
  @ApiOperation({ summary: 'Publish a provisional run (e-signed): official regional quotas, regions notified' })
  publishRun(@Param('id') id: string, @Body() dto: SignatureDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.publishRun(user, id, dto, ctx);
  }

  // ---------------- Adjustment requests (REQ-1.4-002) ----------------
  @Get('adjustment-requests')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Regional quota adjustment requests' })
  listRequests(@CurrentUser() user: AuthUser) {
    return this.runs.listRequests(user);
  }

  @Get('adjustment-requests/stats')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Adjustment request statistics' })
  requestStats(@CurrentUser() user: AuthUser) {
    return this.runs.requestStats(user);
  }

  @Post('adjustment-requests')
  @RequirePermissions('quota:request')
  @ApiOperation({ summary: 'Region requests a quota adjustment (justification + evidence)' })
  createRequest(@Body() dto: CreateAdjustmentRequestDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.createRequest(user, dto, ctx);
  }

  @Post('adjustment-requests/:id/review')
  @HttpCode(200)
  @RequirePermissions('quota:decide')
  @ApiOperation({ summary: 'Mark a request UNDER_REVIEW' })
  reviewRequest(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.runs.reviewRequest(user, id);
  }

  @Post('adjustment-requests/:id/decide')
  @HttpCode(200)
  @RequirePermissions('quota:decide')
  @ApiOperation({ summary: 'Decide a request: APPROVED | PARTIALLY_APPROVED | REJECTED (e-signed)' })
  decideRequest(@Param('id') id: string, @Body() dto: AdjustmentDecisionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.decideRequest(user, id, dto, ctx);
  }

  @Post('adjustment-requests/:id/appeal')
  @HttpCode(200)
  @RequirePermissions('quota:request')
  @ApiOperation({ summary: 'Appeal a rejected / partially approved decision' })
  appeal(@Param('id') id: string, @Body() dto: AppealDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.appeal(user, id, dto, ctx);
  }

  @Post('adjustment-requests/:id/appeal-decision')
  @HttpCode(200)
  @RequirePermissions('quota:decide')
  @ApiOperation({ summary: 'Final & binding appeal decision (e-signed)' })
  appealDecision(@Param('id') id: string, @Body() dto: AdjustmentDecisionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.runs.appealDecision(user, id, dto, ctx);
  }

  // ---------------- Allocations (REQ-1.4-004/005/007/008) ----------------
  @Get('allocations')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Allocation lines (filters: level, parentId, regionId, status; lang=en|am)' })
  async allocations(
    @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response,
    @Query('level') level?: string, @Query('parentId') parentId?: string, @Query('regionId') regionId?: string,
    @Query('status') status?: string, @Query('lang') lang?: string
  ) {
    return paginate(req, res, await this.quota.list(user, { level, parentId, regionId, status }, lang));
  }

  @Get('allocations/downward')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Downward dispatch table: every line below the regional line' })
  async downward(
    @CurrentUser() user: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response,
    @Query('regionId') regionId?: string, @Query('lang') lang?: string
  ) {
    return paginate(req, res, await this.quota.downward(user, regionId, lang));
  }

  @Get('my-allocation')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: "Read-only view of the user's own unit allocation (REQ-1.4-008)" })
  myAllocation(@CurrentUser() user: AuthUser, @Query('lang') lang?: string) {
    return this.quota.myAllocation(user, lang);
  }

  @Get('allocations/:id')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Allocation detail with remaining capacity, children, amendments and history' })
  allocation(@Param('id') id: string, @CurrentUser() user: AuthUser, @Query('lang') lang?: string) {
    return this.quota.detail(user, id, lang);
  }

  @Get('allocations/:id/recommendation')
  @RequirePermissions('quota:allocate')
  @ApiOperation({ summary: 'Recommended split among child units (70% historical, 30% equal)' })
  recommendation(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.quota.recommendation(user, id);
  }

  @Post('allocations/:id/children')
  @RequirePermissions('quota:allocate')
  @ApiOperation({ summary: 'Allocate downward under an approved line' })
  createChild(@Param('id') id: string, @Body() dto: CreateChildAllocationDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.quota.createChild(user, id, dto, ctx);
  }

  @Post('allocations/:id/approve')
  @HttpCode(200)
  @RequirePermissions('quota:allocate')
  @ApiOperation({ summary: 'Approve (e-sign) an allocation at its own level' })
  approve(@Param('id') id: string, @Body() dto: SignatureDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.quota.approve(user, id, dto, ctx);
  }

  @Post('allocations/:id/acknowledge')
  @HttpCode(200)
  @RequirePermissions('quota:acknowledge', 'quota:allocate')
  @ApiOperation({ summary: 'Acknowledge receipt of an allocation' })
  acknowledge(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.quota.acknowledge(user, id, ctx);
  }

  @Patch('allocations/:id/delivery')
  @RequirePermissions('integrations:write', 'quota:allocate')
  @ApiOperation({ summary: 'Delivery tracking / reconciliation update' })
  delivery(@Param('id') id: string, @Body() dto: DeliveryUpdateDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.quota.updateDelivery(user, id, dto, ctx);
  }

  // ---------------- Amendments (REQ-1.4-009) ----------------
  @Get('amendments')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Quota amendments (filter: status)' })
  amendments(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.quota.listAmendments(user, status);
  }

  @Post('allocations/:id/amendments')
  @RequirePermissions('quota:amend')
  @ApiOperation({ summary: 'Request a formal amendment (with impact analysis)' })
  createAmendment(@Param('id') id: string, @Body() dto: CreateAmendmentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.quota.createAmendment(user, id, dto, ctx);
  }

  @Post('amendments/:id/decide')
  @HttpCode(200)
  @RequirePermissions('quota:amend', 'quota:decide')
  @ApiOperation({ summary: 'Approve / reject an amendment (original authorising level or higher; e-signed)' })
  decideAmendment(@Param('id') id: string, @Body() dto: AmendmentDecisionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.quota.decideAmendment(user, id, dto, ctx);
  }

  // ---------------- Letters (REQ-1.4-006) ----------------
  @Post('letters')
  @RequirePermissions('quota:letter')
  @ApiOperation({ summary: 'Issue e-signed quota letters to regional bureaus' })
  createLetters(@Body() dto: CreateLettersDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.letters.createLetters(user, dto, ctx);
  }

  @Get('letters')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Quota letters' })
  listLetters(@CurrentUser() user: AuthUser) {
    return this.letters.listLetters(user);
  }

  @Get('letters/:id')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Quota letter (regional reading marks it READ)' })
  getLetter(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.letters.getLetter(user, id);
  }

  @Get('letters/:id/print')
  @RequirePermissions('quota:read')
  @ApiOperation({ summary: 'Print-ready HTML letter' })
  async printLetter(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const html = await this.letters.printLetter(user, id);
    res.type('html').send(html);
  }

  @Post('letters/:id/acknowledge')
  @HttpCode(200)
  @RequirePermissions('quota:acknowledge')
  @ApiOperation({ summary: 'Acknowledge receipt of a quota letter' })
  acknowledgeLetter(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.letters.acknowledgeLetter(user, id, ctx);
  }

  // ---------------- Procurement requests (REQ-1.4-010) ----------------
  @Post('procurement-requests')
  @RequirePermissions('po:transmit')
  @ApiOperation({ summary: 'Generate & transmit the automatic procurement request / PO to EABC (e-signed)' })
  createPo(@Body() dto: CreateProcurementRequestDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.letters.createProcurementRequest(user, dto, ctx);
  }

  @Get('procurement-requests')
  @RequirePermissions('quota:read', 'integrations:read')
  @ApiOperation({ summary: 'Procurement requests' })
  listPos() {
    return this.letters.listProcurementRequests();
  }

  @Get('procurement-requests/:id')
  @RequirePermissions('quota:read', 'integrations:read')
  @ApiOperation({ summary: 'Procurement request detail' })
  getPo(@Param('id') id: string) {
    return this.letters.getProcurementRequest(id);
  }

  @Post('procurement-requests/:id/status')
  @HttpCode(200)
  @RequirePermissions('po:acknowledge')
  @ApiOperation({ summary: 'EABC status update: RECEIVED | ACKNOWLEDGED | PROCESSING | CLARIFICATION_REQUESTED' })
  poStatus(@Param('id') id: string, @Body() dto: ProcurementStatusDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.letters.updateProcurementStatus(user, id, dto, ctx);
  }
}
