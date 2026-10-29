import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { nowStamp, toCsv } from '../../common/utils/helpers';
import { assertInScope, assertUnitVisible, isNational, unitVisible } from '../../common/utils/scope';
import { HierarchyService, UnitLevel } from '../admin-units/hierarchy.service';
import { AdminUnitsService } from '../admin-units/admin-units.service';
import { COUNTRY_UNIT_ID } from '../admin-units/admin-unit-backfill';
import { AuditService } from '../audit/audit.service';
import { AggregationService } from './aggregation.service';

const UNIT_LEVELS: UnitLevel[] = ['REGION', 'ZONE', 'WOREDA', 'KEBELE'];

@ApiTags('Aggregation & Drill-down (REQ-1.2-001, REQ-INT-006)')
@ApiBearerAuth()
@Controller('aggregation')
export class AggregationController {
  constructor(
    private readonly aggregation: AggregationService,
    private readonly hierarchy: HierarchyService,
    private readonly adminUnits: AdminUnitsService,
    private readonly audit: AuditService
  ) {}

  /**
   * A unit is visible if it is inside the user's area, or the user's area is inside it (upward roll-up view).
   * Farmer-level (KEBELE) detail requires the unit to be inside the user's area.
   */
  private async checkDrillScope(user: AuthUser, level: string, id: string) {
    if (!UNIT_LEVELS.includes(level as UnitLevel)) return;
    const unit = await this.hierarchy.unitRef(level as UnitLevel, id);
    if (!unit) return; // unknown unit: the drill-down answers 404
    if (level === 'KEBELE') assertInScope(user, unit, 'kebele');
    else assertUnitVisible(user, unit);
  }

  /** National views list regions; field officers see only their own (IMPLEMENTATION_ROADMAP §5, decision 4). */
  private async regionVisible(user: AuthUser): Promise<(regionId: string) => boolean> {
    if (isNational(user)) return () => true;
    const refs = new Map<string, boolean>();
    for (const r of await this.adminUnits.children(COUNTRY_UNIT_ID)) refs.set(r.id, unitVisible(user, { regionId: r.id, path: r.path }));
    return id => refs.get(id) ?? false;
  }

  @Get('drilldown')
  @RequirePermissions('aggregation:read')
  @ApiOperation({ summary: 'Drill-down National -> Region -> Zone -> Woreda -> Kebele -> Farmer (format=csv to export)' })
  @ApiQuery({ name: 'level', required: false, enum: ['NATIONAL', 'REGION', 'ZONE', 'WOREDA', 'KEBELE'] })
  @ApiQuery({ name: 'id', required: false })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async drilldown(
    @Query('level') levelQ: string | undefined,
    @Query('id') id: string | undefined,
    @Query('format') format: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response
  ) {
    const level = String(levelQ || 'NATIONAL').toUpperCase();
    if (level !== 'NATIONAL' && !id) throw Errors.badRequest('id is required below NATIONAL level');
    if (id) await this.checkDrillScope(user, level, id);
    const result = await this.aggregation.drilldown(level, id || null);
    if (level === 'NATIONAL') {
      const visible = await this.regionVisible(user);
      result.children = (result.children as any[]).filter(c => visible(c.id));
    }
    if (format === 'csv') {
      await this.audit.record(user, 'DATA_EXPORT', `AGGREGATION/${level}/${id || 'ETH'}`, { format: 'csv' }, ctx);
      res.type('text/csv').attachment(`efmis-${level.toLowerCase()}-${id || 'national'}.csv`);
      const rows: unknown[][] = (result.children as any[]).map(c => [
        c.level, c.id, c.name, c.demandMT ?? c.approvedMT, c.npsbMT ?? c.byFertilizer?.NPSB ?? '', c.ureaMT ?? c.byFertilizer?.UREA ?? '',
        c.registeredFarmers ?? c.farmers ?? '', c.approvalStatus ?? c.status ?? c.approvalLevel ?? ''
      ]);
      rows.push([`Exported ${nowStamp()} by ${user.name}; approved records only`]);
      return toCsv(['Level', 'ID', 'Name', 'Demand (MT)', 'NPSB (MT)', 'Urea (MT)', 'Farmers', 'Status'], rows);
    }
    return result;
  }

  @Get('national')
  @RequirePermissions('national:read', 'aggregation:read')
  @ApiOperation({ summary: 'Gross national demand with reconciliation against regional approvals (REQ-1.3-001)' })
  async national(@CurrentUser() user: AuthUser) {
    const summary = await this.aggregation.nationalSummary();
    const visible = await this.regionVisible(user);
    return { ...summary, regions: summary.regions.filter(r => visible(r.id)), regionsWithPartialData: summary.regionsWithPartialData.filter(r => visible(r.id)) };
  }
}
