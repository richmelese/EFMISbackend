import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { QuotaAdjustmentRequest, QuotaAllocation, QuotaRun } from './entities/quota.entities';
import { Region } from '../hierarchy/entities/region.entity';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { fmtMT, nowStamp, round, shortId, stamp } from '../../common/utils/helpers';
import { isNational } from '../../common/utils/scope';
import { AuditService } from '../audit/audit.service';
import { SignaturesService } from '../signatures/signatures.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { CommentsService } from '../comments/comments.service';
import { QuotaEngineService, QuotaWeights } from './quota-engine.service';
import { AdjustmentDecisionDto, AppealDto, CreateAdjustmentRequestDto, CreateQuotaRunDto, UpdateQuotaWeightsDto } from './dto/quota.dto';

const PENDING_REQUEST = ['SUBMITTED', 'UNDER_REVIEW', 'APPEALED'];

/** Provisional quota runs (REQ-1.4-001) and regional adjustment requests / appeals (REQ-1.4-002). */
@Injectable()
export class QuotaRunsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(QuotaRun) private readonly runs: Repository<QuotaRun>,
    @InjectRepository(QuotaAdjustmentRequest) private readonly requests: Repository<QuotaAdjustmentRequest>,
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    private readonly engine: QuotaEngineService,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly hierarchy: HierarchyService,
    private readonly aggregation: AggregationService,
    private readonly comments: CommentsService
  ) {}

  // ---------------- Weights & provisional preview ----------------
  getWeights(): Promise<QuotaWeights> {
    return this.settings.get<QuotaWeights>('quotaWeights', RULES.defaultQuotaWeights);
  }

  async updateWeights(user: AuthUser, dto: UpdateQuotaWeightsDto, ctx: RequestContext) {
    const w: QuotaWeights = { historical: dto.historical, soilIndex: dto.soilIndex, arrearsPenalty: dto.arrearsPenalty };
    this.engine.validateWeights(w);
    return this.ds.transaction(async m => {
      const old = await this.settings.get('quotaWeights', null, m);
      await this.settings.set('quotaWeights', w, user.name, m);
      await this.audit.record(user, 'QUOTA_ALGORITHM_PARAMETERS_CHANGED', this.engine.algorithmVersion, { old, new: w, reason: dto.justification }, ctx, m);
      return w;
    });
  }

  private async compute(w: QuotaWeights, total: number) {
    const regions = await this.regions.find({ order: { sort: 'ASC' } });
    return this.engine.compute(w, total, regions);
  }

  private async nationalTotal(): Promise<number> {
    return (await this.aggregation.nationalSummary()).grossNationalDemandMT;
  }

  /** Live preview (UI sliders + "Recalculate Quotas"). Query values override the saved weights. */
  async provisional(q: Record<string, unknown>) {
    const saved = await this.getWeights();
    const pick = (key: keyof QuotaWeights) => {
      const raw = q[key];
      const v = raw === undefined || raw === null || raw === '' ? Number(saved[key]) : Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        throw Errors.unprocessable('Request validation failed', [{ field: key, message: `${key} must be a number between 0 and 100` }]);
      }
      return v;
    };
    const w: QuotaWeights = { historical: pick('historical'), soilIndex: pick('soilIndex'), arrearsPenalty: pick('arrearsPenalty') };
    const total = Number(q.totalMT) || (await this.nationalTotal());
    return this.compute(w, total);
  }

  /** Current regional quota table ("Provisional Quota Cascade" tab) */
  async regionTable(user: AuthUser) {
    const rows = (await this.regions.find({ order: { sort: 'ASC' } })).filter(r => isNational(user) || r.id === user.regionId);
    const counts = await this.requests.createQueryBuilder('r').select('r.regionId', 'regionId').addSelect('COUNT(*)', 'c')
      .where('r.status IN (:...s)', { s: PENDING_REQUEST }).groupBy('r.regionId').getRawMany();
    const byRegion = Object.fromEntries(counts.map(c => [c.regionId, Number(c.c)]));
    return rows.map(r => ({
      ...this.hierarchy.regionToFrontend(r),
      npsbMT: Math.round(r.quotaAllocationMt * RULES.productSplit.NPSB),
      ureaMT: Math.round(r.quotaAllocationMt * RULES.productSplit.UREA),
      pendingAdjustmentRequests: byRegion[r.id] || 0
    }));
  }

  // ---------------- Runs ----------------
  runToFrontend(r: QuotaRun) {
    return {
      id: r.id, season: r.season, algorithmVersion: r.algorithmVersion, weights: r.weights, nationalTotalMT: r.nationalTotalMt,
      status: r.status, label: r.label, createdBy: r.createdBy, createdAt: stamp(r.createdAt), results: r.results
    };
  }

  async createRun(user: AuthUser, dto: CreateQuotaRunDto, ctx: RequestContext) {
    const w: QuotaWeights = dto.weights
      ? { historical: dto.weights.historical, soilIndex: dto.weights.soilIndex, arrearsPenalty: dto.weights.arrearsPenalty }
      : await this.getWeights();
    const total = dto.totalMT || (await this.nationalTotal());
    const result = await this.compute(w, total);
    const scenario = dto.scenario ?? false;
    const season = await this.settings.currentSeason();
    const id = shortId('QRUN');
    const run = await this.ds.transaction(async m => {
      const saved = await m.getRepository(QuotaRun).save(m.getRepository(QuotaRun).create({
        id, season, algorithmVersion: this.engine.algorithmVersion, weights: w, nationalTotalMt: total, results: result,
        status: scenario ? 'SCENARIO' : 'PROVISIONAL', label: dto.label || null, createdBy: user.name
      }));
      await this.audit.record(user, 'PROVISIONAL_QUOTA_GENERATED', id, { weights: w, totalMT: total, scenario }, ctx, m);
      return saved;
    });
    return { ...this.runToFrontend(run), message: 'Provisional quotas recalculated across all regions!' };
  }

  async listRuns() {
    const rows = await this.runs.find({ order: { createdAt: 'DESC' } });
    return rows.map(r => this.runToFrontend(r));
  }

  async getRun(id: string) {
    const r = await this.runs.findOneBy({ id });
    if (!r) throw Errors.notFound('Quota run');
    return this.runToFrontend(r);
  }

  async compareRuns(idsParam: string | undefined) {
    const ids = String(idsParam || '').split(',').filter(Boolean);
    if (ids.length < 2) throw Errors.badRequest('Provide ?ids=RUN1,RUN2');
    const runs: ReturnType<QuotaRunsService['runToFrontend']>[] = [];
    for (const id of ids) {
      const r = await this.runs.findOneBy({ id });
      if (!r) throw Errors.notFound(`Quota run ${id}`);
      runs.push(this.runToFrontend(r));
    }
    const regions = (runs[0].results.regions as any[]).map(r => ({
      regionId: r.regionId, regionName: r.regionName,
      quotas: runs.map(run => ({ runId: run.id, weights: run.weights, quotaMT: (run.results.regions as any[]).find(x => x.regionId === r.regionId)?.provisionalQuotaMT }))
    }));
    return { runs: runs.map(r => ({ id: r.id, label: r.label, weights: r.weights, status: r.status })), regions };
  }

  /** Publish: becomes the official regional quota; regional lines updated; regions notified. */
  async publishRun(user: AuthUser, id: string, cred: { pin?: string; password?: string }, ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const runRepo = m.getRepository(QuotaRun);
      const run = await runRepo.findOneBy({ id });
      if (!run) throw Errors.notFound('Quota run');
      if (run.status !== 'PROVISIONAL') throw Errors.conflict(`Only PROVISIONAL runs can be published (this one is ${run.status})`);
      const results = run.results;
      const signature = await this.signatures.sign(user, cred, 'QUOTA_RUN', run.id, (results.regions as any[]).map(r => [r.regionId, r.provisionalQuotaMT]), m);
      await runRepo.update({ status: 'PUBLISHED', season: run.season }, { status: 'SUPERSEDED' });
      await runRepo.update({ id: run.id }, { status: 'PUBLISHED' });
      for (const r of results.regions as any[]) {
        const q: number = r.provisionalQuotaMT;
        const npsb = Math.round(q * RULES.productSplit.NPSB), urea = Math.round(q * RULES.productSplit.UREA);
        await m.getRepository(Region).update({ id: r.regionId }, { quotaAllocationMt: q });
        const lines = await m.getRepository(QuotaAllocation).findBy({ level: 'REGION', regionId: r.regionId, season: run.season });
        for (const l of lines) {
          await m.getRepository(QuotaAllocation).update({ id: l.id }, { npsbMt: npsb, ureaMt: urea, otherMt: q - npsb - urea, version: l.version + 1 });
        }
        await this.notifications.notify({
          role: 'REGION', unitId: r.regionId, title: 'Provisional quota issued',
          message: `${r.regionName}: ${fmtMT(q)} (${r.sharePercent}% of national). Review and request adjustments if needed.`, channels: ['IN_APP', 'EMAIL', 'SMS']
        }, m);
      }
      await this.audit.record(user, 'PROVISIONAL_QUOTA_PUBLISHED', run.id, { signatureId: signature.id }, ctx, m);
      return { ...this.runToFrontend((await runRepo.findOneBy({ id }))!), signature };
    });
  }

  // ---------------- Adjustment requests (REQ-1.4-002) ----------------
  async requestToFrontend(r: QuotaAdjustmentRequest, regionNames?: Record<string, string>) {
    const regionName = regionNames ? regionNames[r.regionId] : (await this.regions.findOneBy({ id: r.regionId }))?.name;
    const comments = await this.comments.list('QUOTA_REQUEST', r.id);
    return {
      id: r.id, regionId: r.regionId, regionName,
      direction: r.direction, amountMT: r.amountMt, justificationType: r.justificationType, justification: r.justification,
      evidence: r.evidence || [], status: r.status, decisionMT: r.decisionMt, decisionComments: r.decisionComments, decidedBy: r.decidedBy,
      appealReason: r.appealReason, createdBy: r.createdBy, createdAt: stamp(r.createdAt), updatedAt: stamp(r.updatedAt),
      comments: comments.map(c => ({ author: c.author, text: c.text, at: c.createdAt }))
    };
  }

  private async regionNames(): Promise<Record<string, string>> {
    return Object.fromEntries((await this.regions.find()).map(r => [r.id, r.name]));
  }

  private async getRequest(id: string, user: AuthUser, repo: Repository<QuotaAdjustmentRequest> = this.requests) {
    const r = await repo.findOneBy({ id });
    if (!r) throw Errors.notFound('Adjustment request');
    if (!isNational(user) && r.regionId !== user.regionId) throw Errors.forbidden();
    return r;
  }

  private async reload(id: string) {
    return this.requestToFrontend((await this.requests.findOneBy({ id }))!);
  }

  async listRequests(user: AuthUser) {
    const rows = await this.requests.find({ where: isNational(user) ? {} : { regionId: user.regionId ?? '' }, order: { createdAt: 'DESC' } });
    const names = await this.regionNames();
    const out: any[] = [];
    for (const r of rows) out.push(await this.requestToFrontend(r, names));
    return out;
  }

  async requestStats() {
    const rows = await this.requests.find({ order: { createdAt: 'ASC' } });
    const quotas = Object.fromEntries((await this.regions.find()).map(r => [r.id, r.quotaAllocationMt]));
    const byRegion: Record<string, { regionId: string; approved: number; rejected: number; pending: number; adjustmentPcts: number[] }> = {};
    for (const r of rows) {
      const s = (byRegion[r.regionId] ||= { regionId: r.regionId, approved: 0, rejected: 0, pending: 0, adjustmentPcts: [] });
      if (/APPROVED/.test(r.status)) s.approved++; else if (/REJECTED/.test(r.status)) s.rejected++; else s.pending++;
      if (r.decisionMt) s.adjustmentPcts.push((r.decisionMt / quotas[r.regionId]) * 100 * (r.direction === 'DECREASE' ? -1 : 1));
    }
    const types: Record<string, number> = {};
    for (const r of rows) types[r.justificationType] = (types[r.justificationType] || 0) + 1;
    return {
      pendingCount: rows.filter(r => PENDING_REQUEST.includes(r.status)).length,
      byRegion: Object.values(byRegion).map(({ adjustmentPcts, ...s }) => ({
        ...s, avgAdjustmentPct: adjustmentPcts.length ? round(adjustmentPcts.reduce((a, b) => a + b, 0) / adjustmentPcts.length, 2) : 0
      })),
      commonJustificationTypes: Object.entries(types).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
    };
  }

  async createRequest(user: AuthUser, dto: CreateAdjustmentRequestDto, ctx: RequestContext) {
    const deadline = await this.settings.get<string | null>('quotaRequestDeadline', null);
    if (deadline && nowStamp() > deadline) throw Errors.conflict(`The adjustment request window closed on ${deadline}`);
    if (!user.regionId) throw Errors.badRequest('Your account is not attached to a region');
    const id = shortId('QAR');
    const body = {
      direction: dto.direction, amountMT: dto.amountMT, justificationType: dto.justificationType, justification: dto.justification,
      evidence: (dto.evidence || []).map(e => ({ name: e.name, ...(e.url ? { url: e.url } : {}), ...(e.documentId ? { documentId: e.documentId } : {}) }))
    };
    await this.ds.transaction(async m => {
      await m.getRepository(QuotaAdjustmentRequest).insert({
        id, regionId: user.regionId!, direction: body.direction, amountMt: body.amountMT, justificationType: body.justificationType,
        justification: body.justification, evidence: body.evidence, createdBy: user.name
      });
      await this.audit.record(user, 'QUOTA_ADJUSTMENT_REQUESTED', id, body, ctx, m);
      await this.notifications.notify({
        role: 'MOA', title: 'Quota adjustment request',
        message: `${user.name}: ${body.direction} ${fmtMT(body.amountMT)} (${body.justificationType})`, channels: ['IN_APP', 'EMAIL']
      }, m);
    });
    return this.reload(id);
  }

  async reviewRequest(user: AuthUser, id: string) {
    const r = await this.getRequest(id, user);
    if (r.status !== 'SUBMITTED') throw Errors.conflict(`Request is ${r.status}`);
    await this.requests.update({ id: r.id }, { status: 'UNDER_REVIEW' });
    return this.reload(r.id);
  }

  async decideRequest(user: AuthUser, id: string, dto: AdjustmentDecisionDto, ctx: RequestContext) {
    const r = await this.getRequest(id, user);
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(r.status)) throw Errors.conflict(`Request is ${r.status}`);
    if (dto.decision === 'REJECTED' && !dto.comments) throw Errors.badRequest('Comments are required when rejecting');
    return this.applyDecision(user, r, dto, ctx, false);
  }

  async appeal(user: AuthUser, id: string, dto: AppealDto, ctx: RequestContext) {
    const r = await this.getRequest(id, user);
    if (!['REJECTED', 'PARTIALLY_APPROVED'].includes(r.status)) throw Errors.conflict('Only rejected or partially approved requests can be appealed');
    await this.ds.transaction(async m => {
      await m.getRepository(QuotaAdjustmentRequest).update({ id: r.id }, { status: 'APPEALED', appealReason: dto.reason });
      await this.audit.record(user, 'QUOTA_DECISION_APPEALED', r.id, { reason: dto.reason }, ctx, m);
      await this.notifications.notify({ role: 'MOA', title: 'Quota decision appealed', message: `${r.id}: ${dto.reason}`, channels: ['IN_APP', 'EMAIL'] }, m);
    });
    return this.reload(r.id);
  }

  /** Final & binding appeal decision */
  async appealDecision(user: AuthUser, id: string, dto: AdjustmentDecisionDto, ctx: RequestContext) {
    const r = await this.getRequest(id, user);
    if (r.status !== 'APPEALED') throw Errors.conflict('Request is not under appeal');
    return this.applyDecision(user, r, dto, ctx, true);
  }

  private async applyDecision(user: AuthUser, r: QuotaAdjustmentRequest, dto: AdjustmentDecisionDto, ctx: RequestContext, appeal: boolean) {
    const { decision, decisionMT, comments } = dto;
    await this.ds.transaction(async m => {
      const signature = await this.signatures.sign(user, dto, 'QUOTA_ADJUSTMENT', r.id, { decision, decisionMT }, m);
      const approvedMT = decision === 'REJECTED' ? 0 : decision === 'APPROVED' ? r.amountMt : (decisionMT as number);
      if (decision === 'PARTIALLY_APPROVED' && !(decisionMT !== undefined && decisionMT > 0 && decisionMT < r.amountMt)) {
        throw Errors.badRequest('Partial approval needs decisionMT between 0 and the requested amount');
      }
      const status = appeal ? (decision === 'REJECTED' ? 'APPEAL_REJECTED' : 'APPEAL_APPROVED') : decision;
      await m.getRepository(QuotaAdjustmentRequest).update({ id: r.id }, { status, decisionMt: approvedMT, decisionComments: comments || null, decidedBy: user.name });
      if (approvedMT > 0) {
        const delta = r.direction === 'INCREASE' ? approvedMT : -approvedMT;
        const region = await m.getRepository(Region).findOneBy({ id: r.regionId });
        if (region) await m.getRepository(Region).update({ id: region.id }, { quotaAllocationMt: region.quotaAllocationMt + delta });
        const dN = Math.round(delta * RULES.productSplit.NPSB), dU = Math.round(delta * RULES.productSplit.UREA);
        const lines = await m.getRepository(QuotaAllocation).findBy({ level: 'REGION', regionId: r.regionId });
        for (const l of lines) {
          await m.getRepository(QuotaAllocation).update({ id: l.id }, {
            npsbMt: l.npsbMt + dN, ureaMt: l.ureaMt + dU, otherMt: l.otherMt + (delta - dN - dU), version: l.version + 1
          });
        }
      }
      await this.audit.record(user, appeal ? 'QUOTA_APPEAL_DECIDED' : 'QUOTA_ADJUSTMENT_DECIDED', r.id, { decision: status, approvedMT, comments, signatureId: signature.id }, ctx, m);
      await this.notifications.notify({
        role: 'REGION', unitId: r.regionId, title: `Quota adjustment ${status.replace('_', ' ').toLowerCase()}`,
        message: `${r.direction} ${fmtMT(r.amountMt)} → ${fmtMT(approvedMT)} approved. ${comments || ''}`, channels: ['IN_APP', 'EMAIL', 'SMS']
      }, m);
    });
    return this.reload(r.id);
  }
}
