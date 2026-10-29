import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { QuotaAllocation, QuotaAmendment } from './entities/quota.entities';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { fmtMT, round, shortId, stamp } from '../../common/utils/helpers';
import { assertInScope, assertUnitVisible, isNational, UnitRef, unitVisible } from '../../common/utils/scope';
import { AdminUnitsService } from '../admin-units/admin-units.service';
import { ltreeLabel } from '../admin-units/admin-unit-backfill';
import { AuditService } from '../audit/audit.service';
import { SignaturesService } from '../signatures/signatures.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AlertsService } from '../alerts/alerts.service';
import { AmendmentDecisionDto, CreateAmendmentDto, CreateChildAllocationDto, DeliveryUpdateDto } from './dto/quota.dto';

export const LEVEL_ORDER = ['REGION', 'ZONE', 'WOREDA', 'KEBELE', 'PC'];
export const LEVEL_RANK: Record<string, number> = { PC: 0, KEBELE: 1, WOREDA: 2, ZONE: 3, REGION: 4, MOA: 5, ADMIN: 6 };
/** Who may allocate below a line: the level that owns the parent (region allocates zones, zone allocates woredas, …) */
const OWNER_ROLE: Record<string, string> = { REGION: 'REGION', ZONE: 'ZONE', WOREDA: 'WOREDA', KEBELE: 'KEBELE' };
const APPROVED_LABEL: Record<string, string> = { ZONE: 'Zone Signed', WOREDA: 'Woreda Signed', KEBELE: 'Kebele Signed', PC: 'Scheduled Dispatch', REGION: 'Region Signed' };

export interface AllocationFilter {
  level?: string;
  parentId?: string;
  regionId?: string;
  status?: string;
}

/**
 * Quota allocation lines & downward cascade (REQ-1.4-004/005/007/008) and formal amendments (REQ-1.4-009).
 * Exported: other modules (USSD) render allocations with allocationToFrontend().
 */
@Injectable()
export class QuotaService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(QuotaAllocation) readonly allocations: Repository<QuotaAllocation>,
    @InjectRepository(QuotaAmendment) private readonly amendments: Repository<QuotaAmendment>,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
    private readonly adminUnits: AdminUnitsService
  ) {}

  // ---------------- Shapes ----------------
  /** Frontend allocation row (QuotaAllocation screen tables). */
  allocationToFrontend(a: QuotaAllocation, lang: string = 'en'): any {
    const total = a.npsbMt + a.ureaMt + a.otherMt;
    // 1 MT = 10 quintals (bags of 50 kg reported separately)
    const qtl = (mt: number) => (a.level === 'PC' ? ` (${Math.round(mt * 10).toLocaleString('en-US')} Qtl)` : '');
    return {
      id: a.id, level: a.level, parentId: a.parentId, regionId: a.regionId, unitId: a.unitId,
      name: lang === 'am' && a.recipientNameAm ? a.recipientNameAm : a.recipientName,
      nameEn: a.recipientName, nameAm: a.recipientNameAm,
      season: a.season,
      npsb: `${Math.round(a.npsbMt).toLocaleString('en-US')} MT${qtl(a.npsbMt)}`,
      urea: `${Math.round(a.ureaMt).toLocaleString('en-US')} MT${qtl(a.ureaMt)}`,
      npsbMT: a.npsbMt, ureaMT: a.ureaMt, otherMT: a.otherMt, totalMT: total,
      quintals: { npsb: Math.round(a.npsbMt * 10), urea: Math.round(a.ureaMt * 10) },
      bags50kg: { npsb: Math.round(a.npsbMt * 20), urea: Math.round(a.ureaMt * 20) },
      source: a.allocationSource, window: a.deliveryWindow, status: a.status,
      badge: /Signed|Delivered/.test(a.status) ? 'badge-glow-green' : 'badge-glow-gold',
      receivedMT: a.receivedMt, remainingMT: Math.max(total - a.receivedMt, 0), deliveredPct: total ? round((a.receivedMt / total) * 100, 1) : 0,
      reconciliationStatus: a.reconciliationStatus, approvalStatus: a.approvalStatus, acknowledgedAt: stamp(a.acknowledgedAt),
      version: a.version, notes: a.notes
    };
  }

  amendmentToFrontend(m: QuotaAmendment) {
    return {
      id: m.id, allocationId: m.allocationId, type: m.amendmentType, before: m.beforeState, proposed: m.proposedState,
      justification: m.justification, evidence: m.evidence || [], impact: m.impact ?? null, status: m.status,
      requestedBy: m.requestedBy, decidedBy: m.decidedBy, decisionComments: m.decisionComments, createdAt: stamp(m.createdAt), decidedAt: stamp(m.decidedAt)
    };
  }

  private stateOf(a: QuotaAllocation) {
    return {
      npsbMT: a.npsbMt, ureaMT: a.ureaMt, otherMT: a.otherMt, deliveryWindow: a.deliveryWindow, recipientName: a.recipientName,
      allocationSource: a.allocationSource, version: a.version
    };
  }

  // ---------------- Scope ----------------
  /**
   * Where each line sits in the unit tree: its unit's admin_units path; for a unit not in the tree yet (PCs, …) the
   * parent line's path extended by the unit id. Lines without either fall back to their region.
   */
  private async scopeRefs(rows: QuotaAllocation[], manager?: EntityManager): Promise<Map<string, UnitRef>> {
    const regionIds = [...new Set(rows.map(a => a.regionId))];
    const all = regionIds.length ? await (manager ? manager.getRepository(QuotaAllocation) : this.allocations).find({ where: { regionId: In(regionIds) } }) : [];
    const byId = new Map([...all, ...rows].map(a => [a.id, a]));
    const unitPaths = new Map((await this.adminUnits.byIds([...new Set(all.map(a => a.unitId).filter((u): u is string => !!u))], manager)).map(u => [u.id, u.path]));
    const paths = new Map<string, string | null>();
    const pathOf = (a: QuotaAllocation, depth = 0): string | null => {
      if (!paths.has(a.id)) {
        const parent = a.parentId ? byId.get(a.parentId) : undefined;
        const up = parent && depth < LEVEL_ORDER.length ? pathOf(parent, depth + 1) : null;
        const own = a.unitId ? unitPaths.get(a.unitId) : undefined;
        paths.set(a.id, own ?? (up && a.unitId ? `${up}.${ltreeLabel(a.unitId)}` : up));
      }
      return paths.get(a.id)!;
    };
    return new Map(rows.map(a => [a.id, { regionId: a.regionId, path: pathOf(a) }]));
  }

  /** Lines inside the user's unit, plus the lines above it that its quota comes from. */
  private async visibleOnly(user: AuthUser, rows: QuotaAllocation[]): Promise<QuotaAllocation[]> {
    if (isNational(user)) return rows;
    const refs = await this.scopeRefs(rows);
    return rows.filter(a => unitVisible(user, refs.get(a.id)!));
  }

  /** Reading a line: inside or above the user's unit. Acting on it (`act`): inside the user's unit. */
  private async assertAllocationScope(user: AuthUser, a: QuotaAllocation, act: boolean, manager?: EntityManager) {
    if (isNational(user)) return;
    const ref = (await this.scopeRefs([a], manager)).get(a.id)!;
    if (act) assertInScope(user, ref, 'quota allocation');
    else assertUnitVisible(user, ref, 'quota allocation');
  }

  // ---------------- Helpers ----------------

  async getAllocation(id: string, manager?: EntityManager): Promise<QuotaAllocation> {
    const a = await (manager ? manager.getRepository(QuotaAllocation) : this.allocations).findOneBy({ id });
    if (!a) throw Errors.notFound('Quota allocation');
    return a;
  }

  childLevel(level: string): string {
    const i = LEVEL_ORDER.indexOf(level);
    if (i < 0 || i === LEVEL_ORDER.length - 1) throw Errors.badRequest(`${level} allocations cannot be sub-allocated (Primary Cooperatives are final recipients)`);
    return LEVEL_ORDER[i + 1];
  }

  private async childTotals(parentId: string, excludeId: string | null = null, manager?: EntityManager) {
    const qb = (manager ? manager.getRepository(QuotaAllocation) : this.allocations).createQueryBuilder('a')
      .select('COALESCE(SUM(a.npsbMt),0)', 'npsb').addSelect('COALESCE(SUM(a.ureaMt),0)', 'urea').addSelect('COALESCE(SUM(a.otherMt),0)', 'other')
      .where('a.parentId = :pid', { pid: parentId });
    if (excludeId) qb.andWhere('a.id != :ex', { ex: excludeId });
    const r = await qb.getRawOne();
    return { npsb: Number(r?.npsb) || 0, urea: Number(r?.urea) || 0, other: Number(r?.other) || 0 };
  }

  /** Remaining capacity under a parent allocation */
  async remainingUnder(parent: QuotaAllocation, excludeId: string | null = null, manager?: EntityManager) {
    const k = await this.childTotals(parent.id, excludeId, manager);
    return { npsbMT: parent.npsbMt - k.npsb, ureaMT: parent.ureaMt - k.urea, otherMT: parent.otherMt - k.other };
  }

  /** Recommended split of a parent line among its child units: 70% historical demand + 30% equal share (REQ-1.4-004) */
  async recommendChildren(parent: QuotaAllocation) {
    const level = this.childLevel(parent.level);
    const rule = '70% historical demand, 30% equal share';
    let units: Array<{ id: string; name: string; hist: number }> = [];
    if (level === 'ZONE') {
      units = await this.ds.query(
        `SELECT z.id, z.name, COALESCE(SUM(k.demand_mt),0) AS hist FROM zones z LEFT JOIN woredas w ON w.zone_id = z.id LEFT JOIN kebeles k ON k.woreda_id = w.id
         WHERE z.region_id = $1 GROUP BY z.id, z.name, z.sort ORDER BY z.sort`, [parent.unitId]);
    } else if (level === 'WOREDA') {
      units = await this.ds.query(
        `SELECT w.id, w.name, COALESCE(SUM(k.demand_mt),0) AS hist FROM woredas w LEFT JOIN kebeles k ON k.woreda_id = w.id
         WHERE w.zone_id = $1 GROUP BY w.id, w.name, w.sort ORDER BY w.sort`, [parent.unitId]);
    } else if (level === 'KEBELE') {
      units = await this.ds.query(`SELECT id, name, demand_mt AS hist FROM kebeles WHERE woreda_id = $1 ORDER BY sort`, [parent.unitId]);
    }
    units = units.map(u => ({ id: u.id, name: u.name, hist: Number(u.hist) || 0 }));
    if (!units.length) return { level, rule, recommendations: [] as any[] };
    const sumHist = units.reduce((s, u) => s + u.hist, 0) || 1;
    return {
      level, rule,
      recommendations: units.map(u => {
        const share = 0.7 * (u.hist / sumHist) + 0.3 / units.length;
        return { unitId: u.id, name: u.name, historicalDemandMT: u.hist, sharePercent: round(share * 100, 2), npsbMT: Math.round(parent.npsbMt * share), ureaMT: Math.round(parent.ureaMt * share) };
      })
    };
  }

  /** Amendment approval needs the original authorising level or higher (REQ-1.4-009) */
  private async canAuthorize(user: AuthUser, a: QuotaAllocation, manager?: EntityManager): Promise<boolean> {
    if (user.role === 'ADMIN') return true;
    const parentLevel = a.parentId ? (await this.getAllocation(a.parentId, manager)).level : 'MOA';
    const required = LEVEL_RANK[parentLevel];
    const have = LEVEL_RANK[user.role] ?? -1;
    return have >= required;
  }

  // ---------------- Allocations ----------------
  async list(user: AuthUser, f: AllocationFilter, lang?: string) {
    const where: any = {};
    if (f.level) where.level = String(f.level).toUpperCase();
    if (f.parentId) where.parentId = f.parentId;
    if (f.regionId) where.regionId = f.regionId;
    if (f.status) where.status = f.status;
    const rows = await this.allocations.find({ where, order: { sort: 'ASC', createdAt: 'ASC' } });
    return (await this.visibleOnly(user, rows)).map(a => this.allocationToFrontend(a, lang));
  }

  /** The "Downward Primary Coop Dispatch" table: everything below the regional line */
  async downward(user: AuthUser, regionIdQ?: string, lang?: string) {
    const regionId = regionIdQ || user.regionId || 'REG-OROMIA';
    const rows = await this.allocations.find({ where: { regionId, level: Not('REGION') }, order: { sort: 'ASC', createdAt: 'ASC' } });
    return (await this.visibleOnly(user, rows)).map(a => this.allocationToFrontend(a, lang));
  }

  async detail(user: AuthUser, id: string, lang?: string) {
    const a = await this.getAllocation(id);
    await this.assertAllocationScope(user, a, false);
    const children = await this.allocations.find({ where: { parentId: a.id }, order: { sort: 'ASC', createdAt: 'ASC' } });
    const amendments = await this.amendments.find({ where: { allocationId: a.id }, order: { createdAt: 'ASC' } });
    return {
      ...this.allocationToFrontend(a, lang),
      remainingForSubAllocation: a.level === 'PC' ? null : await this.remainingUnder(a),
      children: children.map(c => this.allocationToFrontend(c, lang)),
      amendments: amendments.map(m => this.amendmentToFrontend(m)),
      history: await this.audit.list({ target: a.id })
    };
  }

  async recommendation(user: AuthUser, id: string) {
    const a = await this.getAllocation(id);
    await this.assertAllocationScope(user, a, false);
    return this.recommendChildren(a);
  }

  async createChild(user: AuthUser, parentId: string, dto: CreateChildAllocationDto, ctx: RequestContext) {
    const parent = await this.getAllocation(parentId);
    await this.assertAllocationScope(user, parent, true);
    if (!['MOA', 'ADMIN'].includes(user.role) && OWNER_ROLE[parent.level] !== user.role) throw Errors.forbidden(`Only the ${parent.level} level can allocate below this line`);
    if (parent.approvalStatus !== 'APPROVED') throw Errors.conflict('Parent allocation must be approved before allocating downwards');
    const level = this.childLevel(parent.level);
    const otherMT = dto.otherMT ?? 0;
    const id = shortId(`QA-${level}`);
    await this.ds.transaction(async m => {
      const remaining = await this.remainingUnder(parent, null, m);
      if (dto.npsbMT > remaining.npsbMT + 0.001 || dto.ureaMT > remaining.ureaMT + 0.001 || otherMT > remaining.otherMT + 0.001) {
        throw Errors.unprocessable('Allocation exceeds the remaining quota under the parent line', [{ remaining }]);
      }
      // Deviation from the system recommendation requires justification
      const rec = level !== 'PC' ? (await this.recommendChildren(parent)).recommendations.find(r => r.unitId === dto.unitId) : null;
      if (rec && Math.abs(dto.npsbMT - rec.npsbMT) > rec.npsbMT * 0.1 && !dto.justification) {
        throw Errors.unprocessable('Allocation deviates >10% from the recommended allocation; justification is required', [{ recommended: rec }]);
      }
      await m.getRepository(QuotaAllocation).insert({
        id, level, parentId: parent.id, regionId: parent.regionId, unitId: dto.unitId, recipientName: dto.recipientName,
        recipientNameAm: dto.recipientNameAm || null, season: parent.season, npsbMt: dto.npsbMT, ureaMt: dto.ureaMT, otherMt: otherMT,
        allocationSource: dto.allocationSource || null, deliveryWindow: dto.deliveryWindow || null, status: 'Planned',
        notes: dto.notes || dto.justification || null, createdBy: user.name, sort: 1000
      });
      await this.audit.record(user, 'QUOTA_ALLOCATED_DOWNWARD', id, { parentId: parent.id, level, npsbMT: dto.npsbMT, ureaMT: dto.ureaMT, justification: dto.justification }, ctx, m);
      await this.notifications.notify({
        role: level === 'PC' ? 'KEBELE' : level, unitId: dto.unitId, title: 'Quota allocated to you',
        message: `${dto.recipientName}: NPSB ${fmtMT(dto.npsbMT)}, Urea ${fmtMT(dto.ureaMT)}. Please review and approve.`, channels: ['IN_APP', 'SMS']
      }, m);
    });
    return this.allocationToFrontend(await this.getAllocation(id));
  }

  /** Each level approves (e-signs) its own allocation */
  async approve(user: AuthUser, id: string, cred: { pin?: string; password?: string }, ctx: RequestContext) {
    const a = await this.getAllocation(id);
    await this.assertAllocationScope(user, a, true);
    if (a.approvalStatus === 'APPROVED') throw Errors.conflict('Allocation already approved');
    const allowed = ['MOA', 'ADMIN'].includes(user.role) || user.role === a.level || (a.level === 'PC' && user.role === 'KEBELE');
    if (!allowed) throw Errors.forbidden(`Only the ${a.level} level can approve this allocation`);
    const signature = await this.ds.transaction(async m => {
      const sig = await this.signatures.sign(user, cred, 'QUOTA_ALLOCATION', a.id, { npsb: a.npsbMt, urea: a.ureaMt, version: a.version }, m);
      await m.getRepository(QuotaAllocation).update({ id: a.id }, { approvalStatus: 'APPROVED', status: APPROVED_LABEL[a.level], signatureId: sig.id });
      await this.audit.record(user, 'QUOTA_ALLOCATION_APPROVED', a.id, { signatureId: sig.id }, ctx, m);
      return sig;
    });
    return { ...this.allocationToFrontend(await this.getAllocation(a.id)), signature };
  }

  /** Downstream acknowledgement of receipt of the allocation */
  async acknowledge(user: AuthUser, id: string, ctx: RequestContext) {
    const a = await this.getAllocation(id);
    await this.assertAllocationScope(user, a, true);
    await this.ds.transaction(async m => {
      await m.getRepository(QuotaAllocation).update({ id: a.id }, { acknowledgedAt: new Date(), acknowledgedBy: user.name });
      await this.audit.record(user, 'QUOTA_ALLOCATION_ACKNOWLEDGED', a.id, null, ctx, m);
    });
    return this.allocationToFrontend(await this.getAllocation(a.id));
  }

  /** Delivery tracking updates (logistics feeds); a delivered-quantity mismatch raises a reconciliation alert. */
  async updateDelivery(user: AuthUser, id: string, dto: DeliveryUpdateDto, ctx: RequestContext) {
    const a = await this.getAllocation(id);
    await this.assertAllocationScope(user, a, true);
    const received = dto.receivedMT ?? a.receivedMt;
    const total = a.npsbMt + a.ureaMt + a.otherMt;
    const status = dto.status || (received >= total ? 'Delivered' : received > 0 ? 'Partially Delivered' : a.status);
    const recon = Math.abs(received - total) < 0.01 ? 'Reconciled' : received > 0 && status === 'Delivered' ? 'Discrepancy' : 'Pending';
    await this.ds.transaction(async m => {
      await m.getRepository(QuotaAllocation).update({ id: a.id }, { receivedMt: received, status, reconciliationStatus: recon });
      await this.audit.record(user, 'QUOTA_DELIVERY_STATUS_UPDATED', a.id, { old: { receivedMT: a.receivedMt, status: a.status }, new: { receivedMT: received, status } }, ctx, m);
      if (recon === 'Discrepancy') {
        await this.alerts.raise({
          severity: 'MEDIUM_YELLOW', title: `Delivery discrepancy: ${a.recipientName}`, category: 'Logistics & Warehousing',
          trigger: `Delivered ${received} MT vs planned ${total} MT`, affectedArea: a.recipientName, sourceType: 'QUOTA_ALLOCATION', sourceId: a.id,
          dedupeKey: `DISCREPANCY-${a.id}-${received}`
        }, m);
      }
    });
    return this.allocationToFrontend(await this.getAllocation(a.id));
  }

  /** Read-only view for the logged-in user's own unit (REQ-1.4-008) */
  async myAllocation(user: AuthUser, lang?: string) {
    const units = [user.kebeleId, user.woredaId, user.zoneId, user.regionId].filter(Boolean) as string[];
    if (!units.length) throw Errors.badRequest('Your account is not attached to an administrative unit');
    const rows = await this.allocations.find({ where: { unitId: In(units) }, order: { sort: 'ASC' } });
    return rows.map(a => {
      const { source: _s, ...rest } = this.allocationToFrontend(a, lang);
      return { ...rest, readOnly: true };
    });
  }

  // ---------------- Amendments (REQ-1.4-009) ----------------
  async listAmendments(user: AuthUser, status?: string) {
    const rows = await this.amendments.find({ where: status ? { status } : {}, order: { createdAt: 'DESC' } });
    const lines = await this.visibleOnly(user, rows.length ? await this.allocations.findBy({ id: In([...new Set(rows.map(m => m.allocationId))]) }) : []);
    const visible = new Set(lines.map(a => a.id));
    return rows.filter(m => visible.has(m.allocationId)).map(m => this.amendmentToFrontend(m));
  }

  async createAmendment(user: AuthUser, allocationId: string, dto: CreateAmendmentDto, ctx: RequestContext) {
    const a = await this.getAllocation(allocationId);
    await this.assertAllocationScope(user, a, true);
    const before = this.stateOf(a);
    const changes = Object.fromEntries(Object.entries(dto.proposed || {}).filter(([, v]) => v !== undefined));
    const proposed = { ...before, ...changes };
    // Impact analysis
    const parent = a.parentId ? await this.getAllocation(a.parentId) : null;
    const beforeTotal = before.npsbMT + before.ureaMT + before.otherMT;
    const deltaTotal = proposed.npsbMT + proposed.ureaMT + proposed.otherMT - beforeTotal;
    const changePct = round((deltaTotal / Math.max(beforeTotal, 1)) * 100, 2);
    let parentRemainingAfter: { npsbMT: number; ureaMT: number } | null = null;
    if (parent) {
      const r = await this.remainingUnder(parent, a.id);
      parentRemainingAfter = { npsbMT: r.npsbMT - proposed.npsbMT, ureaMT: r.ureaMT - proposed.ureaMT };
    }
    const children = await this.allocations.find({ where: { parentId: a.id }, order: { sort: 'ASC', createdAt: 'ASC' } });
    const kids = await this.childTotals(a.id);
    const impact: any = {
      deltaMT: deltaTotal, changePct, significant: Math.abs(changePct) >= RULES.amendmentEscalationPct,
      parentRemainingAfter,
      childrenAffected: children.map(c => c.recipientName),
      deliveryAffected: ['In Transit', 'Delivered', 'Partially Delivered'].includes(a.status),
      childAllocatedTotals: { npsb: kids.npsb, urea: kids.urea }
    };
    if (parentRemainingAfter && (parentRemainingAfter.npsbMT < -0.001 || parentRemainingAfter.ureaMT < -0.001)) {
      throw Errors.unprocessable('Amended quantity exceeds what is available under the parent allocation', [impact]);
    }
    if (proposed.npsbMT < kids.npsb || proposed.ureaMT < kids.urea) {
      impact.alternatives = ['Reduce sub-allocations first, or amend the child lines proportionally'];
    }
    const id = shortId('AMD');
    const evidence = (dto.evidence || []).map(e => ({ name: e.name, ...(e.url ? { url: e.url } : {}) }));
    await this.ds.transaction(async m => {
      await m.getRepository(QuotaAmendment).insert({
        id, allocationId: a.id, amendmentType: dto.type, beforeState: before as any, proposedState: proposed as any, justification: dto.justification,
        evidence: evidence as any, impact, requestedBy: user.name
      });
      await this.audit.record(user, 'QUOTA_AMENDMENT_REQUESTED', a.id, { amendmentId: id, type: dto.type, old: before, new: proposed, reason: dto.justification }, ctx, m);
      const approverRole = parent ? parent.level : 'MOA';
      await this.notifications.notify({
        role: approverRole, title: impact.significant ? 'URGENT: significant quota amendment' : 'Quota amendment awaiting approval',
        message: `${a.recipientName}: ${dto.type} (${changePct}%)`, channels: impact.significant ? ['IN_APP', 'EMAIL', 'SMS'] : ['IN_APP']
      }, m);
    });
    return this.amendmentToFrontend((await this.amendments.findOneBy({ id }))!);
  }

  async decideAmendment(user: AuthUser, id: string, dto: AmendmentDecisionDto, ctx: RequestContext) {
    const m0 = await this.amendments.findOneBy({ id });
    if (!m0) throw Errors.notFound('Amendment');
    if (m0.status !== 'PENDING_APPROVAL') throw Errors.conflict(`Amendment is ${m0.status}`);
    const a = await this.getAllocation(m0.allocationId);
    await this.assertAllocationScope(user, a, true);
    if (!(await this.canAuthorize(user, a))) throw Errors.forbidden('Amendments require approval from the original authorising level (or higher)');
    if (!dto.approve && !dto.comments) throw Errors.badRequest('Comments are required when rejecting an amendment');
    await this.ds.transaction(async m => {
      const signature = await this.signatures.sign(user, dto, 'QUOTA_AMENDMENT', m0.id, { approve: dto.approve, proposed: m0.proposedState }, m);
      await m.getRepository(QuotaAmendment).update({ id: m0.id }, {
        status: dto.approve ? 'APPROVED' : 'REJECTED', decidedBy: user.name, decisionComments: dto.comments || null, signatureId: signature.id, decidedAt: new Date()
      });
      if (dto.approve) {
        const p = m0.proposedState || {};
        const cur = await this.getAllocation(a.id, m);
        await m.getRepository(QuotaAllocation).update({ id: a.id }, {
          npsbMt: p.npsbMT, ureaMt: p.ureaMT, otherMt: p.otherMT, deliveryWindow: p.deliveryWindow ?? null, recipientName: p.recipientName,
          allocationSource: p.allocationSource ?? null, version: cur.version + 1
        });
      }
      await this.audit.record(user, dto.approve ? 'QUOTA_AMENDMENT_APPROVED' : 'QUOTA_AMENDMENT_REJECTED', a.id, { amendmentId: m0.id, comments: dto.comments, signatureId: signature.id }, ctx, m);
      await this.notifications.notify({
        role: a.level === 'PC' ? 'KEBELE' : a.level, unitId: a.unitId, title: `Quota amendment ${dto.approve ? 'approved' : 'rejected'}`,
        message: `${a.recipientName}: ${m0.amendmentType}. ${m0.justification}`, channels: ['IN_APP', 'SMS']
      }, m);
    });
    return this.amendmentToFrontend((await this.amendments.findOneBy({ id: m0.id }))!);
  }
}
