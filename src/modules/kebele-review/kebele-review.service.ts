import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Farmer } from '../farmers/entities/farmer.entity';
import { FarmerDemand } from '../farmers/entities/farmer-demand.entity';
import { ApprovalAction } from '../approvals/entities/approval-action.entity';
import { FarmersService, PENDING_KEBELE } from '../farmers/farmers.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { SignatureResult, SignaturesService } from '../signatures/signatures.service';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { round } from '../../common/utils/helpers';
import { assertInScope, scopeCondition } from '../../common/utils/scope';
import { KebeleApproveDto, KebeleBulkDto, KebelePartialDto, KebeleRejectDto, KebeleRevisionDto } from './dto/kebele-review.dto';

export const KEBELE_LEVEL = {
  APPROVE: 'Kebele Approved • Forwarded to Woreda',
  REJECT: 'Rejected by Kebele',
  REQUEST_REVISION: 'Returned for Revision',
  PARTIAL_APPROVE: 'Partially Approved • Revision Requested'
} as const;

type KebeleAction = keyof typeof KEBELE_LEVEL;

/** Kebele review and approval (REQ-1.1-007). */
@Injectable()
export class KebeleReviewService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly farmers: FarmersService,
    private readonly signatures: SignaturesService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService
  ) {}

  // ------------------------------------------------------------------ helpers

  /** Lock the farmer row for the duration of the transaction and ensure it is pending kebele review. */
  private async pendingRow(m: EntityManager, id: string, user: AuthUser): Promise<Farmer> {
    if (!id) throw Errors.notFound('Farmer');
    const f = await m.getRepository(Farmer).findOne({ where: { id, deleted: false }, lock: { mode: 'pessimistic_write' } });
    if (!f) throw Errors.notFound('Farmer');
    assertInScope(user, this.farmers.unitOf(f), 'farmer');
    if (f.approvalLevel !== PENDING_KEBELE) throw Errors.conflict(`Record is already "${f.approvalLevel}"`);
    return f;
  }

  private lines(m: EntityManager, farmerId: string) {
    return m.getRepository(FarmerDemand).find({ where: { farmerId }, order: { id: 'ASC' } });
  }

  private setLevel(m: EntityManager, farmerId: string, level: string) {
    // version + 1 and updated_at = now() are applied automatically by the update query builder
    return m.createQueryBuilder().update(Farmer).set({ approvalLevel: level }).where('id = :id', { id: farmerId }).execute();
  }

  private async record(
    m: EntityManager, user: AuthUser, f: Farmer, action: KebeleAction, comments: string | null | undefined,
    details: Record<string, unknown> | null, signature: SignatureResult, ctx: RequestContext
  ) {
    await this.approvals.record(user, {
      entityType: 'FARMER', entityId: f.id, level: 'KEBELE', action, comments: comments || null, details, signatureId: signature?.id || null
    }, m);
    await this.audit.record(user, `KEBELE_${action}`, f.id, { comments, ...(details || {}), signatureId: signature?.id }, ctx, m);
    if (f.daUserId) {
      await this.notifications.notify({
        userId: f.daUserId,
        title: `Farmer record ${action.replace('_', ' ').toLowerCase()}`,
        message: `${f.name} (${f.id}): ${KEBELE_LEVEL[action]}${comments ? ' - ' + comments : ''}`
      }, m);
    }
  }

  /** Approve every line (approved qty defaults to min(requested, recommended) unless overridden). */
  private async approveAll(m: EntityManager, f: Farmer, overrides: Record<string, number> = {}) {
    const lines = await this.lines(m, f.id);
    const blocking = (await this.farmers.qualityFlags(f, lines)).filter(x => x.severity === 'BLOCKING');
    if (blocking.length) throw Errors.unprocessable('Record cannot be approved', blocking);
    for (const d of lines) {
      const qty = overrides[d.type] ?? Math.min(d.requestedQtl, d.recommendedQtl);
      await m.getRepository(FarmerDemand).update({ id: d.id }, { status: 'APPROVED', approvedQtl: round(qty) });
    }
    await this.setLevel(m, f.id, KEBELE_LEVEL.APPROVE);
  }

  private async fresh(id: string) {
    return this.farmers.toFrontend(await this.farmers.getRow(id));
  }

  // ------------------------------------------------------------------ dashboard

  async queue(user: AuthUser) {
    const s = scopeCondition(user, 'f', 'kebeleId');
    const rows = await this.farmers.repo.createQueryBuilder('f').leftJoinAndSelect('f.demands', 'd')
      .where('f.deleted = false').andWhere(s.sql, s.params)
      .orderBy('f.submissionDate', 'ASC').addOrderBy('f.id', 'ASC').addOrderBy('d.id', 'ASC').getMany();
    const farmers = await this.farmers.manyToFrontend(rows);
    const pending = farmers.filter(f => f.approvalLevel === PENDING_KEBELE);

    const decided: Array<{ action: string; decidedAt: Date; submittedAt: Date }> = await this.ds.getRepository(ApprovalAction).createQueryBuilder('a')
      .innerJoin(Farmer, 'f', 'f.id = a.entityId')
      .select('a.action', 'action').addSelect('a.createdAt', 'decidedAt').addSelect('f.createdAt', 'submittedAt')
      .where(`a.entityType = 'FARMER'`).andWhere(`a.level = 'KEBELE'`).andWhere(s.sql, s.params)
      .getRawMany();
    const approvals = decided.filter(d => d.action === 'APPROVE' || d.action === 'PARTIAL_APPROVE').length;
    const hours = decided.map(d => (new Date(d.decidedAt).getTime() - new Date(d.submittedAt).getTime()) / 36e5).filter(h => h >= 0);
    const ageDays = (f: any) => Math.floor((Date.now() - new Date(`${f.submissionDate}T00:00:00`).getTime()) / 864e5);

    return {
      farmers,
      stats: {
        pendingCount: pending.length,
        flaggedCount: pending.filter(f => f.qualityFlags.some((q: any) => q.code === 'DEMAND_ANOMALY')).length,
        arrearsCount: pending.filter(f => f.creditArrearsETB > 0).length,
        approvalRatePct: decided.length ? round((approvals / decided.length) * 100, 1) : null,
        avgTimeToApprovalHours: hours.length ? round(hours.reduce((sum, h) => sum + h, 0) / hours.length, 1) : null,
        oldestPendingDays: pending.length ? Math.max(...pending.map(ageDays)) : 0,
        escalationThresholdDays: await this.settings.get<number>('kebeleEscalationDays', 7)
      }
    };
  }

  // ------------------------------------------------------------------ single-record decisions

  async approve(user: AuthUser, id: string, dto: KebeleApproveDto, ctx: RequestContext) {
    const overrides = dto.approvedQtl || {};
    const bad = Object.entries(overrides).filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v) || v < 0);
    if (bad.length) throw Errors.unprocessable('Request validation failed', bad.map(([k]) => ({ field: `approvedQtl.${k}`, message: 'Must be a number >= 0' })));

    const { f, signature } = await this.ds.transaction(async m => {
      const f = await this.pendingRow(m, id, user);
      const signature = await this.signatures.sign(user, dto, 'FARMER_DEMAND', f.id, { action: 'APPROVE', approvedQtl: dto.approvedQtl || null }, m);
      await this.approveAll(m, f, overrides);
      await this.record(m, user, f, 'APPROVE', dto.comments, { approvedQtl: dto.approvedQtl }, signature, ctx);
      return { f, signature };
    });
    return { farmer: await this.fresh(f.id), signature, message: `Farmer ${f.id} approved with Kebele electronic signature!` };
  }

  async reject(user: AuthUser, id: string, dto: KebeleRejectDto, ctx: RequestContext) {
    const { f, signature } = await this.ds.transaction(async m => {
      const f = await this.pendingRow(m, id, user);
      const signature = await this.signatures.sign(user, dto, 'FARMER_DEMAND', f.id, { action: 'REJECT', reason: dto.reason }, m);
      await m.getRepository(FarmerDemand).update({ farmerId: f.id }, { status: 'REJECTED', approvedQtl: 0, reviewComment: dto.reason });
      await this.setLevel(m, f.id, KEBELE_LEVEL.REJECT);
      await this.record(m, user, f, 'REJECT', dto.reason, null, signature, ctx);
      return { f, signature };
    });
    return { farmer: await this.fresh(f.id), signature };
  }

  async requestRevision(user: AuthUser, id: string, dto: KebeleRevisionDto, ctx: RequestContext) {
    const { f, signature } = await this.ds.transaction(async m => {
      const f = await this.pendingRow(m, id, user);
      const signature = await this.signatures.sign(user, dto, 'FARMER_DEMAND', f.id, { action: 'REQUEST_REVISION', comments: dto.comments }, m);
      const types = dto.types;
      await m.getRepository(FarmerDemand).update(
        types ? { farmerId: f.id, type: In(types) } : { farmerId: f.id },
        { status: 'REVISION_REQUESTED', reviewComment: dto.comments }
      );
      await this.setLevel(m, f.id, KEBELE_LEVEL.REQUEST_REVISION);
      await this.record(m, user, f, 'REQUEST_REVISION', dto.comments, { types }, signature, ctx);
      return { f, signature };
    });
    return { farmer: await this.fresh(f.id), signature };
  }

  /** Partial approval: e.g. approve DAP, request revision for Urea. */
  async partial(user: AuthUser, id: string, dto: KebelePartialDto, ctx: RequestContext) {
    const { f, signature } = await this.ds.transaction(async m => {
      const f = await this.pendingRow(m, id, user);
      const signature = await this.signatures.sign(user, dto, 'FARMER_DEMAND', f.id, { action: 'PARTIAL_APPROVE', approve: dto.approve, revise: dto.revise }, m);
      const repo = m.getRepository(FarmerDemand);
      for (const a of dto.approve) {
        const d = await repo.findOne({ where: { farmerId: f.id, type: a.type } });
        if (!d) throw Errors.badRequest(`No ${a.type} demand line on this record`);
        await repo.update({ id: d.id }, { status: 'APPROVED', approvedQtl: round(a.approvedQtl ?? Math.min(d.requestedQtl, d.recommendedQtl)) });
      }
      for (const r of dto.revise) {
        const d = await repo.findOne({ where: { farmerId: f.id, type: r.type } });
        if (!d) throw Errors.badRequest(`No ${r.type} demand line on this record`);
        await repo.update({ id: d.id }, { status: 'REVISION_REQUESTED', reviewComment: r.comment });
      }
      await this.setLevel(m, f.id, KEBELE_LEVEL.PARTIAL_APPROVE);
      await this.record(m, user, f, 'PARTIAL_APPROVE', null, { approve: dto.approve, revise: dto.revise }, signature, ctx);
      return { f, signature };
    });
    return { farmer: await this.fresh(f.id), signature };
  }

  // ------------------------------------------------------------------ bulk

  /** Bulk operations: max 100 records, same kebele & season, common reason, one signature for the batch. */
  async bulk(user: AuthUser, dto: KebeleBulkDto, ctx: RequestContext) {
    const action = dto.action || 'APPROVE';
    const s = scopeCondition(user, 'f', 'kebeleId');
    const ids = dto.farmerIds;

    return this.ds.transaction(async m => {
      const qb = m.getRepository(Farmer).createQueryBuilder('f').where('f.deleted = false').andWhere(s.sql, s.params);
      if (ids && ids.length) qb.andWhere('f.id IN (:...ids)', { ids });
      else qb.andWhere('f.approvalLevel = :pending', { pending: PENDING_KEBELE }).orderBy('f.submissionDate', 'ASC').addOrderBy('f.id', 'ASC').limit(RULES.bulkApprovalMax);
      const rows = await qb.setLock('pessimistic_write').getMany();
      if (!rows.length) throw Errors.badRequest('No pending records in your kebele to process');
      if (new Set(rows.map(r => r.kebeleId)).size > 1 || new Set(rows.map(r => r.season)).size > 1) {
        throw Errors.unprocessable('Bulk operations are allowed only for records of the same kebele and season');
      }
      const rowIds = rows.map(r => r.id);
      const signature = await this.signatures.sign(user, dto, 'FARMER_DEMAND_BATCH', rowIds.join(','), { action, ids: rowIds }, m);

      const threshold = await this.farmers.anomalyThreshold();
      const processed: string[] = [];
      const skipped: Array<{ id: string; reason: string; flags?: unknown }> = [];
      for (const f of rows) {
        if (f.approvalLevel !== PENDING_KEBELE) {
          skipped.push({ id: f.id, reason: `Already ${f.approvalLevel}` });
          continue;
        }
        const flags = await this.farmers.qualityFlags(f, await this.lines(m, f.id), threshold);
        if (action === 'APPROVE') {
          if (flags.some(x => x.severity === 'BLOCKING')) {
            skipped.push({ id: f.id, reason: 'Incomplete / blocking data quality issue' });
            continue;
          }
          if (!dto.includeWarnings && flags.length) {
            skipped.push({ id: f.id, reason: flags.map(x => x.code).join(', '), flags });
            continue;
          }
          await this.approveAll(m, f);
        } else if (action === 'REJECT') {
          await m.getRepository(FarmerDemand).update({ farmerId: f.id }, { status: 'REJECTED', approvedQtl: 0, reviewComment: dto.reason });
          await this.setLevel(m, f.id, KEBELE_LEVEL.REJECT);
        } else {
          await m.getRepository(FarmerDemand).update({ farmerId: f.id }, { status: 'REVISION_REQUESTED', reviewComment: dto.reason });
          await this.setLevel(m, f.id, KEBELE_LEVEL.REQUEST_REVISION);
        }
        await this.record(m, user, f, action, dto.reason, { bulk: true }, signature, ctx);
        processed.push(f.id);
      }
      return {
        action, processed, skipped, signature,
        message: action === 'APPROVE'
          ? `${processed.length} compliant Kebele demand records bulk-approved (${skipped.length} skipped)`
          : `${processed.length} records processed`
      };
    });
  }
}
