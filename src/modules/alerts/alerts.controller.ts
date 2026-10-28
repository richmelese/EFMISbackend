import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsIn, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { DataSource, EntityManager } from 'typeorm';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AlertSeverity, RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { paginate } from '../../common/utils/helpers';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { AuditService } from '../audit/audit.service';
import { CommentsService } from '../comments/comments.service';
import { Alert } from './entities/alert.entity';
import { AlertsService } from './alerts.service';

// ---------------- DTOs ----------------
class CreateAlertDto {
  @ApiProperty({ enum: RULES.alertSeverities }) @IsIn(RULES.alertSeverities) severity: AlertSeverity;
  @ApiProperty() @IsString() @MinLength(5) title: string;
  @ApiProperty() @IsString() @MinLength(3) category: string;
  @ApiPropertyOptional() @IsOptional() @IsString() trigger?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() affectedArea?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() actionRequired?: string;
}

class AssignAlertDto {
  @ApiProperty() @IsString() @MinLength(2) assignee: string;
}

class ResolveAlertDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) resolutionNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() rootCause?: string;
}

class ReopenAlertDto {
  @ApiProperty() @IsString() @MinLength(3) reason: string;
}

class SnoozeAlertDto {
  @ApiProperty({ minimum: 1, maximum: 168 }) @IsNumber() @Min(1) @Max(168) hours: number;
  @ApiProperty() @IsString() @MinLength(3) reason: string;
}

class AlertListQuery extends PageQueryDto {
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() resolved?: string;
  @IsOptional() @IsString() status?: string;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL_RED: 0, HIGH_ORANGE: 1, MEDIUM_YELLOW: 2 };

/** Critical event alerts & PMO SLA centre (REQ-1.2-006, REQ-INT-005). */
@ApiTags('Critical Alerts (REQ-INT-005)')
@ApiBearerAuth()
// Available at /api/alerts (EFMIS) and /api/v1/alerts (Logistics API inventory)
@Controller({ path: 'alerts', version: [VERSION_NEUTRAL, '1'] })
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly comments: CommentsService,
    @InjectDataSource() private readonly ds: DataSource
  ) {}

  private async get(id: string, m?: EntityManager): Promise<Alert> {
    const a = await (m ? m.getRepository(Alert) : this.alerts.repo).findOneBy({ id });
    if (!a) throw Errors.notFound('Alert');
    return a;
  }

  /** Load, mutate (inside a transaction), audit, return the updated alert. */
  private async transition(id: string, action: string, user: AuthUser, details: unknown, ctx: RequestContext,
    mutate: (a: Alert, m: EntityManager) => Promise<unknown>) {
    return this.ds.transaction(async m => {
      const a = await this.get(id, m);
      await mutate(a, m);
      await this.audit.record(user, `ALERT_${action}`, a.id, details ?? {}, ctx, m);
      return this.alerts.toFrontend(await this.get(a.id, m));
    });
  }

  @Get()
  @RequirePermissions('alerts:read')
  @ApiOperation({ summary: 'List alerts (severity, category, resolved, status; page/pageSize) — open first, by severity then newest' })
  async list(@Query() q: AlertListQuery, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const qb = this.alerts.repo.createQueryBuilder('a');
    if (q.severity) qb.andWhere('a.severity = :severity', { severity: q.severity });
    if (q.category) qb.andWhere('a.category = :category', { category: q.category });
    if (q.resolved !== undefined) qb.andWhere('a.resolved = :resolved', { resolved: q.resolved === 'true' });
    if (q.status) qb.andWhere('a.status = :status', { status: q.status });
    const rows = await qb.getMany();
    rows.sort((x, y) => Number(x.resolved) - Number(y.resolved)
      || (SEVERITY_RANK[x.severity] ?? 3) - (SEVERITY_RANK[y.severity] ?? 3)
      || (y.timestamp || '').localeCompare(x.timestamp || ''));
    return paginate(req, res, rows.map(r => this.alerts.toFrontend(r)));
  }

  @Get('summary')
  @RequirePermissions('alerts:read')
  @ApiOperation({ summary: 'Open / resolved counts, by severity and category, SLA breaches' })
  async summary() {
    const rows = (await this.alerts.repo.find()).map(r => this.alerts.toFrontend(r));
    const open = rows.filter(a => !a.resolved);
    return {
      open: open.length,
      resolved: rows.length - open.length,
      bySeverity: Object.fromEntries(RULES.alertSeverities.map(s => [s, open.filter(a => a.severity === s).length])),
      slaBreached: open.filter(a => a.slaBreached).length,
      awaitingAcknowledgement: open.filter(a => ['CRITICAL_RED', 'HIGH_ORANGE'].includes(a.severity) && !a.acknowledgedAt).length,
      byCategory: open.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.category]: (acc[a.category] || 0) + 1 }), {})
    };
  }

  @Get(':id')
  @RequirePermissions('alerts:read')
  @ApiOperation({ summary: 'Alert detail with comment thread and audit history' })
  async detail(@Param('id') id: string) {
    const a = await this.get(id);
    const comments = await this.comments.list('ALERT', a.id);
    return {
      ...this.alerts.toFrontend(a),
      comments: comments.map(c => ({ author: c.author, text: c.text, at: c.createdAt })),
      history: await this.audit.list({ target: a.id })
    };
  }

  @Post()
  @RequirePermissions('alerts:create')
  @ApiOperation({ summary: 'Raise a manual alert (routed to PMO / MoA per severity)' })
  async create(@Body() dto: CreateAlertDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const a = await this.alerts.raise({ ...dto, sourceType: 'MANUAL', sourceId: user.id }, m);
      await this.audit.record(user, 'ALERT_RAISED', a.id, dto, ctx, m);
      return a;
    });
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @RequirePermissions('alerts:manage', 'alerts:read')
  @ApiOperation({ summary: 'Acknowledge an alert' })
  acknowledge(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'ACKNOWLEDGED', user, {}, ctx, async (a, m) => {
      if (a.resolved) throw Errors.conflict('Alert already resolved');
      await m.getRepository(Alert).update({ id: a.id }, { status: 'ACKNOWLEDGED', acknowledgedBy: user.name, acknowledgedAt: new Date() });
    });
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('alerts:manage')
  @ApiOperation({ summary: 'Assign an alert for investigation' })
  assign(@Param('id') id: string, @Body() dto: AssignAlertDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'ASSIGNED', user, dto, ctx, async (a, m) => {
      await m.getRepository(Alert).update({ id: a.id }, { status: 'INVESTIGATING', assignedTo: dto.assignee });
    });
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermissions('alerts:manage')
  @ApiOperation({ summary: 'Resolve an alert (resolution notes required for Critical/High)' })
  resolve(@Param('id') id: string, @Body() dto: ResolveAlertDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'RESOLVED', user, dto, ctx, async (a, m) => {
      if (a.resolved) throw Errors.conflict('Alert already resolved');
      if (['CRITICAL_RED', 'HIGH_ORANGE'].includes(a.severity) && !dto.resolutionNotes) {
        throw Errors.badRequest('Resolution notes (root cause / corrective action) are required for Critical and High alerts');
      }
      const notes = [dto.rootCause && `Root cause: ${dto.rootCause}`, dto.resolutionNotes].filter(Boolean).join(' | ') || null;
      await m.getRepository(Alert).update({ id: a.id }, { status: 'RESOLVED', resolved: true, resolvedBy: user.name, resolvedAt: new Date(), resolutionNotes: notes });
    });
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('alerts:manage')
  @ApiOperation({ summary: 'Close a resolved alert (verification step)' })
  close(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'CLOSED', user, {}, ctx, async (a, m) => {
      if (!a.resolved) throw Errors.conflict('Resolve the alert before closing (verification step)');
      await m.getRepository(Alert).update({ id: a.id }, { status: 'CLOSED' });
    });
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermissions('alerts:manage')
  @ApiOperation({ summary: 'Re-open an alert' })
  reopen(@Param('id') id: string, @Body() dto: ReopenAlertDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'REOPENED', user, dto, ctx, async (a, m) => {
      await m.getRepository(Alert).update({ id: a.id }, { status: 'OPEN', resolved: false, resolvedBy: null, resolvedAt: null });
    });
  }

  @Post(':id/snooze')
  @HttpCode(200)
  @RequirePermissions('alerts:manage')
  @ApiOperation({ summary: 'Snooze a non-critical alert (1-168 hours)' })
  snooze(@Param('id') id: string, @Body() dto: SnoozeAlertDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'SNOOZED', user, dto, ctx, async (a, m) => {
      if (a.severity === 'CRITICAL_RED') throw Errors.conflict('Critical alerts cannot be muted or snoozed');
      await m.getRepository(Alert).update({ id: a.id }, { status: 'SNOOZED', snoozedUntil: new Date(Date.now() + dto.hours * 36e5), snoozeReason: dto.reason });
    });
  }

  @Post(':id/toggle')
  @HttpCode(200)
  @RequirePermissions('alerts:manage')
  @ApiOperation({ summary: 'Toggle resolved/open (dashboard "Resolve" button)' })
  toggle(@Param('id') id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.transition(id, 'TOGGLED', user, {}, ctx, async (a, m) => {
      if (a.resolved) await m.getRepository(Alert).update({ id: a.id }, { status: 'OPEN', resolved: false, resolvedBy: null, resolvedAt: null });
      else await m.getRepository(Alert).update({ id: a.id }, { status: 'RESOLVED', resolved: true, resolvedBy: user.name, resolvedAt: new Date() });
    });
  }
}
