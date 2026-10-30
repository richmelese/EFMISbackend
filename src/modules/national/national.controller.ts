import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { NationalService } from './national.service';
import {
  CloseFtwgSessionDto, CreateActionItemDto, CreateFtwgSessionDto, ExportQueryDto, FtwgVoteDto, MinutesQueryDto,
  RejectDocumentDto, SignDocumentDto, UpdateActionItemDto, UpdateCarryOverDto
} from './dto/national.dto';

@ApiTags('National Validation (REQ-1.3)')
@ApiBearerAuth()
@Controller('national')
export class NationalController {
  constructor(private readonly national: NationalService) {}

  // ---------------------------------------------------------------- figures
  @Get('summary')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Everything the National Validation screen needs in one call' })
  summary(@CurrentUser() user: AuthUser) {
    return this.national.summary(user);
  }

  @Get('gross-demand')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Gross national demand with reconciliation (REQ-1.3-001)' })
  grossDemand(@CurrentUser() user: AuthUser) {
    return this.national.grossDemand(user);
  }

  @Get('net-import')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Net import requirement = gross demand - usable carry-over (REQ-1.3-004)' })
  netImport() {
    return this.national.netImport();
  }

  @Get('carry-over')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Carry-over stocks by facility tier and fertilizer (REQ-1.3-004)' })
  carryOver() {
    return this.national.carryOver();
  }

  @Patch('carry-over/:type')
  @RequirePermissions('national:edit')
  @ApiOperation({ summary: 'Adjust a carry-over line (>10% change of usable stock requires justification)' })
  updateCarryOver(@Param('type') type: string, @Body() dto: UpdateCarryOverDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.updateCarryOver(user, type, dto, ctx);
  }

  @Get('export')
  @RequirePermissions('national:read')
  @ApiOperation({ summary: 'Export the national demand (format=csv|json)' })
  async export(@Query() q: ExportQueryDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const out = await this.national.exportNational(user, q.format, ctx);
    if (typeof out.csv === 'string') {
      res.type('text/csv').attachment(out.filename);
      return out.csv;
    }
    return out;
  }

  // ---------------------------------------------------------------- FTWG collaborative review (REQ-1.3-003)
  @Get('ftwg/sessions')
  @RequirePermissions('ftwg:participate', 'national:read')
  @ApiOperation({ summary: 'List FTWG review sessions (newest first)' })
  listSessions(@CurrentUser() user: AuthUser) {
    return this.national.listSessions(user);
  }

  @Post('ftwg/sessions')
  @RequirePermissions('ftwg:manage')
  @ApiOperation({ summary: 'Open an FTWG review session' })
  createSession(@Body() dto: CreateFtwgSessionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.createSession(user, dto, ctx);
  }

  @Get('ftwg/sessions/:id')
  @RequirePermissions('ftwg:participate', 'national:read')
  @ApiOperation({ summary: 'FTWG session with tally, votes, discussion and action items' })
  getSession(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.national.ftwgSession(id, user);
  }

  @Post('ftwg/sessions/:id/vote')
  @HttpCode(200)
  @RequirePermissions('ftwg:vote')
  @ApiOperation({ summary: 'Cast a consensus vote (one per member)' })
  vote(@Param('id') id: string, @Body() dto: FtwgVoteDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.castVote(user, id, dto.vote, dto.comment, ctx);
  }

  @Post('ftwg/sessions/:id/close')
  @HttpCode(200)
  @RequirePermissions('ftwg:manage')
  @ApiOperation({ summary: 'Close voting and record the decision' })
  close(@Param('id') id: string, @Body() dto: CloseFtwgSessionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.closeSession(user, id, dto.decision, ctx);
  }

  @Get('ftwg/sessions/:id/minutes')
  @RequirePermissions('ftwg:participate', 'national:read')
  @ApiOperation({ summary: 'Auto-generated meeting minutes (format=text for plain text)' })
  async minutes(@Param('id') id: string, @Query() q: MinutesQueryDto, @Res({ passthrough: true }) res: Response) {
    const m = await this.national.minutes(id);
    if (q.format === 'text') {
      res.type('text/plain');
      return m.text;
    }
    return m;
  }

  @Post('ftwg/sessions/:id/action-items')
  @RequirePermissions('ftwg:manage')
  @ApiOperation({ summary: 'Add an action item to a session' })
  addActionItem(@Param('id') id: string, @Body() dto: CreateActionItemDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.addActionItem(user, id, dto, ctx);
  }

  @Patch('ftwg/action-items/:itemId')
  @RequirePermissions('ftwg:participate')
  @ApiOperation({ summary: 'Update an action item status' })
  updateActionItem(@Param('itemId', ParseIntPipe) itemId: number, @Body() dto: UpdateActionItemDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.updateActionItem(user, itemId, dto.status, ctx);
  }

  // ---------------------------------------------------------------- formal demand document (REQ-1.3-005)
  @Get('documents')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'List demand documents (newest first)' })
  listDocuments(@CurrentUser() user: AuthUser) {
    return this.national.listDocuments(user);
  }

  @Get('documents/latest')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Latest demand document' })
  async latestDocument(@CurrentUser() user: AuthUser) {
    const d = await this.national.latestDocumentFor(user);
    if (!d) throw Errors.notFound('Demand document');
    return d;
  }

  @Post('documents')
  @RequirePermissions('national:edit')
  @ApiOperation({ summary: 'Generate a new demand document and start the sequential signing workflow' })
  createDocument(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.createDocument(user, ctx);
  }

  @Get('documents/:id')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Get a demand document (access is audited)' })
  getDocument(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.getDocument(user, id, ctx);
  }

  @Post('documents/:id/sign')
  @HttpCode(200)
  @RequirePermissions('document:sign')
  @ApiOperation({ summary: 'Apply the next sequential signature (FTWG Chair -> ATI DG -> MoA State Minister)' })
  sign(@Param('id') id: string, @Body() dto: SignDocumentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.signDocument(user, id, dto, ctx);
  }

  @Post('documents/:id/reject')
  @HttpCode(200)
  @RequirePermissions('document:sign')
  @ApiOperation({ summary: 'Reject the document at the current signing step (comments required)' })
  reject(@Param('id') id: string, @Body() dto: RejectDocumentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.national.signDocument(user, id, null, ctx, { reject: true, comments: dto.comments });
  }

  @Get('documents/:id/verify')
  @RequirePermissions('national:read', 'ftwg:participate')
  @ApiOperation({ summary: 'Tamper-evident verification of content hash and signatures' })
  verify(@Param('id') id: string) {
    return this.national.verifyDocument(id);
  }
}
