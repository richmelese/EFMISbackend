import { Body, Controller, Get, HttpCode, Param, Post, Query, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { AvailableActionDto, WorkflowActDto, WorkflowCaseDetailDto, WorkflowCaseDto, WorkflowEntityQueryDto, WorkflowHistoryEntryDto } from './dto/workflow.dto';
import { WorkflowService } from './workflow.service';

/**
 * Shared approval API used by the frontend's ApprovalActions / HistoryTimeline. Permissions are per action (from the
 * workflow definition), so routes only require a signed-in user; scope is checked on every case.
 */
@ApiTags('Workflow')
@ApiBearerAuth()
@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Version('1')
  @Get('cases')
  @ApiOperation({ summary: 'Cases of one record or unit that the user can read' })
  @ApiOkResponse({ type: WorkflowCaseDto, isArray: true })
  async forEntity(@Query() q: WorkflowEntityQueryDto, @CurrentUser() user: AuthUser): Promise<WorkflowCaseDto[]> {
    const out: WorkflowCaseDto[] = [];
    for (const c of await this.workflow.forEntity(q.entityType, q.entityId)) if (await this.workflow.canRead(user, c)) out.push(this.workflow.toDto(c));
    return out;
  }

  @Version('1')
  @Get('cases/:id')
  @ApiOperation({ summary: 'A case with the actions available to the user and its history' })
  @ApiOkResponse({ type: WorkflowCaseDetailDto })
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<WorkflowCaseDetailDto> {
    const c = await this.workflow.byId(id);
    await this.workflow.assertReadable(user, c);
    return { case: this.workflow.toDto(c), available: await this.workflow.available(user, c), history: await this.workflow.history(c.entityType, c.entityId) };
  }

  @Version('1')
  @Get('cases/:id/available')
  @ApiOperation({ summary: 'Actions the user may take on the case now' })
  @ApiOkResponse({ type: AvailableActionDto, isArray: true })
  async available(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<AvailableActionDto[]> {
    const c = await this.workflow.byId(id);
    await this.workflow.assertReadable(user, c);
    return this.workflow.available(user, c);
  }

  @Version('1')
  @Post('cases/:id/actions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Take an action (transition, permission and scope checked; e-signature when the step requires it)' })
  @ApiOkResponse({ type: WorkflowCaseDto })
  async act(@Param('id') id: string, @Body() dto: WorkflowActDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<WorkflowCaseDto> {
    const { action, ...input } = dto;
    return this.workflow.toDto(await this.workflow.act(user, id, action, input, ctx));
  }

  @Version('1')
  @Get('history')
  @ApiOperation({ summary: 'Approval history of a record or unit (legacy approvals merged with workflow actions)' })
  @ApiOkResponse({ type: WorkflowHistoryEntryDto, isArray: true })
  history(@Query() q: WorkflowEntityQueryDto, @CurrentUser() user: AuthUser): Promise<WorkflowHistoryEntryDto[]> {
    return this.workflow.historyFor(user, q.entityType, q.entityId);
  }
}
