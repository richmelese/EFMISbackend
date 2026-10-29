import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { DemandAdjustment } from './entities/demand-adjustment.entity';
import { Farmer } from '../farmers/entities/farmer.entity';
import { Kebele } from '../hierarchy/entities/kebele.entity';
import { Woreda } from '../hierarchy/entities/woreda.entity';
import { Zone } from '../hierarchy/entities/zone.entity';
import { can, Permission } from '../../common/constants/permissions';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { fmtMT, round, stamp } from '../../common/utils/helpers';
import { assertInScope, assertUnitVisible, scopeCondition } from '../../common/utils/scope';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { AuditService } from '../audit/audit.service';
import { SignaturesService } from '../signatures/signatures.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AlertsService } from '../alerts/alerts.service';
import { CommentsService } from '../comments/comments.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AdjustmentQueryDto, CreateAdjustmentDto, CreateCommentDto, DecisionDto, ScenarioDto } from './dto/reviews.dto';

interface LevelConfig {
  entity: 'WOREDA' | 'ZONE';
  label: string;
  childType: 'KEBELE' | 'WOREDA';
  permission: Permission;
  next: 'ZONE' | 'REGION';
  farmerFrom: string[];
  farmerTo: string;
  farmerCol: 'woredaId' | 'zoneId';
}

const LEVELS: Record<string, LevelConfig> = {
  woreda: {
    entity: 'WOREDA', label: 'Woreda', childType: 'KEBELE', permission: 'woreda:review', next: 'ZONE',
    farmerFrom: ['Kebele Approved • Forwarded to Woreda', 'Kebele Approved'], farmerTo: 'Woreda Approved', farmerCol: 'woredaId'
  },
  zone: {
    entity: 'ZONE', label: 'Zone', childType: 'WOREDA', permission: 'zone:review', next: 'REGION',
    farmerFrom: ['Woreda Approved'], farmerTo: 'Zone Approved', farmerCol: 'zoneId'
  }
};

/** Absolute change (%) from which an adjustment is flagged as significant. */
const SIGNIFICANT_ADJUSTMENT_PCT = 10;

type ReviewUnit = { id: string; name: string; status: string };

/** Comment scopes that are administrative units (others — FTWG, ALERT, … — are scoped by their own module). */
const UNIT_THREADS = ['REGION', 'ZONE', 'WOREDA', 'KEBELE'] as const;

/** Woreda & Zone review, demand adjustments, comment threads and approval (REQ-1.2-002, -003, -004). */
@Injectable()
export class ReviewsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(DemandAdjustment) private readonly adjustments: Repository<DemandAdjustment>,
    private readonly hierarchy: HierarchyService,
    private readonly aggregation: AggregationService,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
    private readonly comments: CommentsService,
    private readonly approvals: ApprovalsService
  ) {}

  private resolveLevel(level: string): LevelConfig {
    const cfg = LEVELS[String(level).toLowerCase()];
    if (!cfg) throw Errors.badRequest('level must be "woreda" or "zone"');
    return cfg;
  }

  private async loadUnit(cfg: LevelConfig, unitId: string, user: AuthUser): Promise<ReviewUnit> {
    const unit: ReviewUnit | null = cfg.entity === 'WOREDA'
      ? await this.hierarchy.woredas.findOne({ where: { id: unitId } })
      : await this.hierarchy.zones.findOne({ where: { id: unitId } });
    if (!unit) throw Errors.notFound(cfg.label);
    assertInScope(user, await this.hierarchy.unitRef(cfg.entity, unitId), 'unit');
    return unit;
  }

  /** Comment threads on a unit are shared by the unit and the levels above and below it. */
  private async assertThreadVisible(user: AuthUser, scopeType: string, scopeId: string) {
    const level = UNIT_THREADS.find(t => t === scopeType);
    if (!level) return;
    const ref = await this.hierarchy.unitRef(level, scopeId);
    if (!ref) throw Errors.notFound(`${scopeType} ${scopeId}`);
    assertUnitVisible(user, ref, 'unit');
  }

  adjustmentToFrontend(a: DemandAdjustment) {
    const sign = a.changePct > 0 ? '+' : '';
    return {
      id: a.id, level: a.level, unitType: a.unitType, unitId: a.unitId, kebele: a.unitName, unitName: a.unitName,
      raw: fmtMT(a.rawMt), adj: `${fmtMT(a.adjustedMt)} (${sign}${a.changePct}%)`,
      rawMT: a.rawMt, adjustedMT: a.adjustedMt, changePct: a.changePct, reason: a.justification,
      version: a.version, author: a.authorName, createdAt: stamp(a.createdAt), significant: Math.abs(a.changePct) >= SIGNIFICANT_ADJUSTMENT_PCT
    };
  }

  // ---------------- Review dashboard ----------------
  async dashboard(level: string, unitId: string, user: AuthUser) {
    const cfg = this.resolveLevel(level);
    const unit = await this.loadUnit(cfg, unitId, user);
    const drill = await this.aggregation.drilldown(cfg.entity, unit.id);
    const children: any[] = drill.children;
    const childIds = children.map(c => c.id);
    const adjustments = childIds.length
      ? await this.adjustments.createQueryBuilder('a')
        .where('a.unitId IN (:...ids)', { ids: childIds })
        .orWhere('(a.unitId IS NULL AND a.level = :lvl)', { lvl: cfg.entity })
        .orderBy('a.id', 'ASC').getMany()
      : [];
    const decisions = await this.approvals.history(cfg.entity, unit.id);
    const statusCount = (s: string) => children.filter(c => c.status === s).length;
    return {
      ...drill,
      status: unit.status,
      adjustments: adjustments.map(a => this.adjustmentToFrontend(a)),
      comments: await this.comments.list(cfg.entity, unit.id),
      decisions: decisions.map(d => ({ action: d.action, comments: d.comments, by: d.by, at: d.at, details: d.details, signatureId: d.signatureId })),
      dashboard: {
        pendingSubmissions: statusCount('PENDING'),
        approved: statusCount('APPROVED'), returned: statusCount('RETURNED'), held: statusCount('HELD'),
        significantAdjustmentAlerts: adjustments.filter(a => Math.abs(a.changePct) >= SIGNIFICANT_ADJUSTMENT_PCT).length,
        totalAdjustedMT: adjustments.reduce((s, a) => s + (a.adjustedMt - a.rawMt), 0)
      }
    };
  }

  // ---------------- Adjustments ----------------
  async listAdjustments(q: AdjustmentQueryDto, user: AuthUser) {
    const s = scopeCondition(user, 'a', 'unitId');
    const qb = this.adjustments.createQueryBuilder('a').where(s.sql, s.params);
    if (q.level) qb.andWhere('a.level = :level', { level: String(q.level).toUpperCase() });
    if (q.unitId) {
      const unit = await this.hierarchy.adminUnits.unitRef(q.unitId);
      if (unit) assertInScope(user, unit, 'unit');
      qb.andWhere('a.unitId = :unitId', { unitId: q.unitId });
    }
    const rows = await qb.orderBy('a.id', 'ASC').getMany();
    return rows.map(a => this.adjustmentToFrontend(a));
  }

  async createAdjustment(dto: CreateAdjustmentDto, user: AuthUser, ctx: RequestContext) {
    if (dto.changePct === undefined && dto.adjustedMT === undefined) throw Errors.unprocessable('Provide changePct or adjustedMT');
    const level: 'WOREDA' | 'ZONE' = user.role === 'ZONE' ? 'ZONE' : 'WOREDA';

    const saved = await this.ds.transaction(async m => {
      let unit: { id: string; name: string };
      let unitType: 'KEBELE' | 'WOREDA';
      let rawMT: number;
      if (level === 'WOREDA') {
        const k = await m.getRepository(Kebele).findOne({ where: { id: dto.unitId } });
        if (!k) throw Errors.notFound('Kebele');
        assertInScope(user, await this.hierarchy.unitRef('KEBELE', k.id), 'kebele');
        unit = k; unitType = 'KEBELE'; rawMT = k.demandMt;
      } else {
        const w = await m.getRepository(Woreda).findOne({ where: { id: dto.unitId } });
        if (!w) throw Errors.notFound('Woreda');
        assertInScope(user, await this.hierarchy.unitRef('WOREDA', w.id), 'woreda');
        unit = w; unitType = 'WOREDA';
        const r = await m.getRepository(Kebele).createQueryBuilder('k').select('COALESCE(SUM(k.demandMt),0)', 's').where('k.woredaId = :id', { id: w.id }).getRawOne();
        rawMT = Number(r?.s) || 0;
      }
      const adjusted = dto.adjustedMT ?? Math.round(rawMT * (1 + (dto.changePct as number) / 100));
      const pct = rawMT ? round(((adjusted - rawMT) / rawMT) * 100, 1) : 0;
      const repo = m.getRepository(DemandAdjustment);
      const version = (await repo.count({ where: { unitId: unit.id } })) + 1;
      const row = await repo.save(repo.create({
        level, unitType, unitId: unit.id, unitName: unit.name, rawMt: rawMT, adjustedMt: adjusted, changePct: pct,
        justification: dto.justification, version, userId: user.id, authorName: user.name
      }));
      if (unitType === 'KEBELE') {
        await m.getRepository(Kebele).update({ id: unit.id }, { demandMt: adjusted });
      } else if (rawMT > 0) {
        await m.getRepository(Kebele).createQueryBuilder().update()
          .set({ demandMt: () => 'ROUND(demand_mt * :factor)' })
          .where('woreda_id = :wid', { wid: unit.id })
          .setParameter('factor', adjusted / rawMT)
          .execute();
      }
      await this.audit.record(user, `${level}_DEMAND_ADJUSTED`, unit.id, { old: rawMT, new: adjusted, changePct: pct, justification: dto.justification, version }, ctx, m);
      // Adjustments are visible to the level below and above
      await this.notifications.notify({
        role: unitType === 'KEBELE' ? 'KEBELE' : 'WOREDA', unitId: unit.id, title: 'Demand adjusted',
        message: `${unit.name}: ${fmtMT(rawMT)} → ${fmtMT(adjusted)} (${pct}%) - ${dto.justification}`
      }, m);
      await this.notifications.notify({
        role: level === 'WOREDA' ? 'ZONE' : 'REGION', title: 'Demand adjustment for review', message: `${user.name} adjusted ${unit.name} by ${pct}%`
      }, m);
      return row;
    });
    return this.adjustmentToFrontend(saved);
  }

  // ---------------- Comments ----------------
  async listComments(scopeType: string, scopeId: string, user: AuthUser) {
    await this.assertThreadVisible(user, scopeType, scopeId);
    return this.comments.list(scopeType, scopeId);
  }

  async addComment(dto: CreateCommentDto, user: AuthUser, ctx: RequestContext) {
    await this.assertThreadVisible(user, dto.scopeType, dto.scopeId);
    const comment = await this.ds.transaction(async m => {
      const c = await this.comments.add(user, dto.scopeType, dto.scopeId, dto.text, dto.parentId ?? null, m);
      await this.audit.record(user, 'REVIEW_COMMENT_ADDED', `${dto.scopeType}:${dto.scopeId}`, { commentId: c.id }, ctx, m);
      return c;
    });
    return { ...comment, message: 'Audit note added to collaborative ledger!' };
  }

  // ---------------- Decision ----------------
  async decide(level: string, unitId: string, dto: DecisionDto, user: AuthUser, ctx: RequestContext) {
    const cfg = this.resolveLevel(level);
    if (!can(user, cfg.permission)) throw Errors.forbidden(`Only ${cfg.label} officers can decide at this level`);
    const unit = await this.loadUnit(cfg, unitId, user);
    const { action, comments } = dto;
    if (['RETURN', 'HOLD', 'DISPUTE'].includes(action) && !comments) throw Errors.badRequest(`Comments/reason are required for ${action}`);
    if (action === 'DISPUTE' && cfg.entity !== 'ZONE') throw Errors.badRequest('Dispute resolution is a zone-level action');
    const approveIds = dto.approveChildIds || [];
    const returnIds = dto.returnChildIds || [];
    if (action === 'PARTIAL_APPROVE' && (!approveIds.length || !returnIds.length)) throw Errors.badRequest('Partial approval needs approveChildIds and returnChildIds');

    const result = await this.ds.transaction(async m => {
      const signature = await this.signatures.sign(user, dto, `${cfg.entity}_DEMAND`, unit.id,
        { action, comments, approve: dto.approveChildIds, ret: dto.returnChildIds }, m);
      const childRepo = cfg.entity === 'WOREDA' ? m.getRepository(Kebele) : m.getRepository(Woreda);
      const unitRepo = cfg.entity === 'WOREDA' ? m.getRepository(Woreda) : m.getRepository(Zone);
      const childWhere = cfg.entity === 'WOREDA' ? { woredaId: unit.id } : { zoneId: unit.id };
      const setChild = async (ids: string[], status: string) => {
        if (ids.length) await childRepo.update({ id: In(ids), ...childWhere }, { status });
      };
      const setUnit = (status: string) => unitRepo.update({ id: unit.id }, { status });

      if (action === 'APPROVE') {
        await childRepo.update(childWhere, { status: 'APPROVED' });
        await setUnit('APPROVED');
        await m.getRepository(Farmer).update({ [cfg.farmerCol]: unit.id, approvalLevel: In(cfg.farmerFrom) }, { approvalLevel: cfg.farmerTo });
      } else if (action === 'PARTIAL_APPROVE') {
        await setChild(approveIds, 'APPROVED');
        await setChild(returnIds, 'RETURNED');
        await setUnit('PARTIALLY_APPROVED');
      } else if (action === 'RETURN') {
        if (returnIds.length) await setChild(returnIds, 'RETURNED');
        else await childRepo.update(childWhere, { status: 'RETURNED' });
        await setUnit('RETURNED');
      } else if (action === 'HOLD') {
        await setUnit('HELD');
      } else if (action === 'DISPUTE') {
        await setUnit('DISPUTED');
      }

      await this.approvals.record(user, {
        entityType: cfg.entity, entityId: unit.id, level: cfg.entity, action, comments: comments || null,
        details: { approve: dto.approveChildIds, ret: dto.returnChildIds }, signatureId: signature.id
      }, m);
      await this.audit.record(user, `${cfg.entity}_${action}`, unit.id, { comments, signatureId: signature.id }, ctx, m);

      if (action === 'APPROVE') {
        await this.notifications.notify({
          role: cfg.next, title: `${unit.name} demand approved`, message: `${user.name} approved & forwarded ${unit.name} demand`, channels: ['IN_APP', 'EMAIL']
        }, m);
      } else {
        await this.notifications.notify({ role: cfg.childType, title: `${unit.name}: ${action.replace('_', ' ').toLowerCase()}`, message: comments || action }, m);
      }
      if (action === 'DISPUTE') {
        await this.alerts.raise({
          severity: 'MEDIUM_YELLOW', title: `Demand dispute flagged in ${unit.name}`, category: 'Demand Anomaly', trigger: comments,
          affectedArea: unit.name, actionRequired: 'Regional bureau review of zone/woreda discrepancy', sourceType: 'ZONE', sourceId: unit.id
        }, m);
      }
      const current = await unitRepo.findOne({ where: { id: unit.id } });
      return { status: current?.status ?? unit.status, signature };
    });

    const message = action === 'APPROVE'
      ? `${unit.name} demand approved & forwarded to ${cfg.next === 'ZONE' ? 'Zone' : 'Regional Bureau'}!`
      : `${unit.name}: ${action}`;
    return { unitId: unit.id, status: result.status, signature: result.signature, message };
  }

  // ---------------- Scenario modelling ----------------
  async scenario(dto: ScenarioDto, user: AuthUser) {
    const unit = await this.hierarchy.unitRef(dto.level, dto.unitId);
    if (!unit) throw Errors.notFound(`${dto.level} ${dto.unitId}`);
    assertUnitVisible(user, unit, 'unit');
    const drill = await this.aggregation.drilldown(dto.level, dto.unitId);
    const map: Record<string, number> = Object.fromEntries(dto.adjustments.map(a => [a.childId, a.changePct]));
    const kids: any[] = drill.children;
    const children = kids.map(c => {
      const pct = map[c.id] || 0;
      const base = Number(c.demandMT) || 0;
      const scenarioMT = Math.round(base * (1 + pct / 100));
      return { id: c.id, name: c.name, baselineMT: c.demandMT, changePct: pct, scenarioMT, deltaMT: scenarioMT - base };
    });
    const baseline = kids.reduce((s, c) => s + (Number(c.demandMT) || 0), 0);
    const scenario = children.reduce((s, c) => s + c.scenarioMT, 0);
    return {
      unit: drill.unit, baselineMT: baseline, scenarioMT: scenario, deltaMT: scenario - baseline,
      deltaPct: baseline ? round(((scenario - baseline) / baseline) * 100, 2) : 0, byFertilizer: this.aggregation.byType(scenario), children
    };
  }
}
