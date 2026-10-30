import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { can, NATIONAL_ROLES } from '../../common/constants/permissions';
import { DomainEvents } from '../../common/events';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { shortId, stamp } from '../../common/utils/helpers';
import { assertUnitVisible, inScope, UnitRef, unitVisible } from '../../common/utils/scope';
import { AdminUnitsService } from '../admin-units/admin-units.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SignaturesService } from '../signatures/signatures.service';
import { WorkflowAction } from './entities/workflow-action.entity';
import { ApprovalAction } from './entities/approval-action.entity';
import { WorkflowCase } from './entities/workflow-case.entity';
import { AvailableActionDto, WorkflowCaseDto, WorkflowHistoryEntryDto } from './dto/workflow.dto';
import { WorkflowRegistry } from './workflow.registry';
import { DEFAULT_NOTIFY_CHANNELS, transitionFor, WorkflowAdvanced, WorkflowDefinition, WorkflowEscalated } from './workflow.types';

export interface ActInput {
  pin?: string;
  password?: string;
  comments?: string | null;
  details?: Record<string, unknown> | null;
  /** Reject with 409 when the case changed since the caller read it */
  expectedVersion?: number;
}

const SYSTEM = 'system';
/** Reminder interval once a case without escalation is overdue. */
const REMINDER_EVERY_HOURS = 24;
const addHours = (from: Date, h: number) => new Date(from.getTime() + h * 3_600_000);

/**
 * Generic workflow engine (Stage B4). Domain modules register definitions (WorkflowRegistry), open cases inside their
 * own transactions and react to WorkflowAdvanced. Every action checks transition + permission + scope, signs when
 * required, writes workflow_actions + audit, publishes the event and notifies the next assignee (in-app + outbox) —
 * atomically.
 */
@Injectable()
export class WorkflowService {
  private readonly logger = new Logger('Workflow');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(WorkflowCase) private readonly cases: Repository<WorkflowCase>,
    @InjectRepository(WorkflowAction) private readonly actions: Repository<WorkflowAction>,
    @InjectRepository(ApprovalAction) private readonly legacyApprovals: Repository<ApprovalAction>,
    private readonly registry: WorkflowRegistry,
    private readonly units: AdminUnitsService,
    private readonly signatures: SignaturesService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEvents
  ) {}

  private definitionOf(name: string): WorkflowDefinition {
    const def = this.registry.get(name);
    if (!def) throw Errors.badRequest(`Unknown workflow definition ${name}`);
    return def;
  }

  private async inTx<T>(m: EntityManager | undefined, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return m ? fn(m) : this.ds.transaction(fn);
  }

  private dueAt(def: WorkflowDefinition, status: string, from = new Date()): Date | null {
    const h = def.deadlineHours?.[status];
    return h ? addHours(from, h) : null;
  }

  // ------------------------------------------------------------------ open

  /**
   * Opens a case. RECORD: `entityId` is the record (entity type from the definition). UNIT_SEASON: the entity is the
   * unit itself (entity type = unit type) and a season is required. 409 when the case already exists.
   */
  async open(
    definition: string,
    entity: { id: string },
    unitId: string,
    seasonId: string | null,
    m?: EntityManager,
    actor?: AuthUser
  ): Promise<WorkflowCase> {
    const def = this.definitionOf(definition);
    return this.inTx(m, async tx => {
      const unit = await this.units.byId(unitId, tx);
      if (def.shape === 'UNIT_SEASON') {
        if (!seasonId) throw Errors.badRequest(`${def.name} cases are per unit and season: seasonId is required`);
        if (entity.id !== unitId) throw Errors.badRequest(`${def.name} cases are opened on the unit itself`);
      }
      const entityType = def.shape === 'UNIT_SEASON' ? unit.type : def.entityType!;
      const repo = tx.getRepository(WorkflowCase);
      const exists = await repo.exists({ where: { definition: def.name, entityType, entityId: entity.id, seasonId: seasonId ?? IsNull() } });
      if (exists) throw Errors.conflict(`A ${def.name} case already exists for ${entityType} ${entity.id}`);
      const c = repo.create({
        id: shortId('WFC'), definition: def.name, entityType, entityId: entity.id, seasonId, level: unit.type, status: def.initialStatus,
        assigneeUnitId: unit.id, originUnitId: unit.id, dueAt: this.dueAt(def, def.initialStatus), escalationLevel: 0, version: 1, closedAt: null
      });
      await repo.insert(c);
      await this.logAction(tx, {
        caseId: c.id, action: 'OPEN', fromStatus: null, toStatus: c.status, level: c.level,
        actorId: actor?.id ?? null, actorName: actor?.name ?? SYSTEM, comments: null, details: null, signatureId: null
      });
      await this.notifyAssignee(def, c, tx);
      return c;
    });
  }

  // ------------------------------------------------------------------ act

  async act(user: AuthUser, caseId: string, action: string, input: ActInput = {}, ctx: RequestContext = {}, m?: EntityManager): Promise<WorkflowCase> {
    return this.inTx(m, async tx => {
      const repo = tx.getRepository(WorkflowCase);
      const c = await repo.findOne({ where: { id: caseId }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw Errors.notFound('Workflow case');
      const def = this.definitionOf(c.definition);
      if (input.expectedVersion !== undefined && input.expectedVersion !== c.version) {
        throw Errors.conflict('The case changed since you opened it; reload and try again', { version: c.version });
      }
      const t = transitionFor(def, c.status, action);
      if (!t) {
        const allowed = def.transitions.filter(x => x.from.includes(c.status)).map(x => x.action);
        throw Errors.conflict(`Action ${action} is not available while the case is ${c.status}`, { status: c.status, allowed });
      }
      if (!can(user, t.permission)) throw Errors.forbidden(`Action ${action} requires the ${t.permission} permission`);
      const assignee = await this.refOf(c.assigneeUnitId, tx);
      if (!inScope(user, assignee)) throw Errors.outOfScope('case');
      const comments = input.comments?.trim() || null;
      if (t.commentsRequired && !comments) throw Errors.badRequest(`Comments are required for ${action}`);

      const signature = t.signature
        ? await this.signatures.sign(user, input, `WORKFLOW:${def.name}`, c.id, { caseId: c.id, action, from: c.status, to: t.to, comments, details: input.details ?? null }, tx)
        : null;

      const from = c.status;
      const fromLevel = c.level;
      let nextUnit = c.assigneeUnitId;
      if (t.assign === 'PARENT') nextUnit = (await this.units.byId(c.assigneeUnitId, tx)).parentId ?? c.assigneeUnitId;
      else if (t.assign === 'ORIGIN') nextUnit = c.originUnitId;
      const closed = def.terminal.includes(t.to);
      c.level = nextUnit === c.assigneeUnitId ? c.level : (await this.units.byId(nextUnit, tx)).type;
      c.status = t.to;
      c.assigneeUnitId = nextUnit;
      c.dueAt = closed ? null : this.dueAt(def, t.to);
      c.escalationLevel = 0;
      c.closedAt = closed ? new Date() : null;
      const updated = await repo.update({ id: c.id, version: c.version }, {
        status: c.status, assigneeUnitId: c.assigneeUnitId, level: c.level, dueAt: c.dueAt, escalationLevel: 0, closedAt: c.closedAt, version: c.version + 1
      });
      if (!updated.affected) throw Errors.conflict('The case changed while you were acting; reload and try again');
      c.version += 1;

      await this.logAction(tx, {
        caseId: c.id, action, fromStatus: from, toStatus: t.to, level: fromLevel, actorId: user.id, actorName: user.name,
        comments, details: input.details ?? null, signatureId: signature?.id ?? null
      });
      await this.audit.record(user, `WORKFLOW_${action}`, `${c.entityType}:${c.entityId}`, {
        caseId: c.id, definition: def.name, old: from, new: t.to, comments, signatureId: signature?.id ?? null
      }, ctx, tx);
      await this.events.publish(new WorkflowAdvanced(c.id, def.name, c.entityType, c.entityId, action, from, t.to, c.assigneeUnitId, user.id, closed), tx);
      if (!closed) await this.notifyAssignee(def, c, tx);
      return c;
    });
  }

  // ------------------------------------------------------------------ read

  async byId(id: string): Promise<WorkflowCase> {
    const c = await this.cases.findOne({ where: { id } });
    if (!c) throw Errors.notFound('Workflow case');
    return c;
  }

  forEntity(entityType: string, entityId: string): Promise<WorkflowCase[]> {
    return this.cases.find({ where: { entityType, entityId }, order: { createdAt: 'ASC' } });
  }

  private async refOf(unitId: string, m?: EntityManager): Promise<UnitRef> {
    return (await this.units.unitRef(unitId, m)) ?? { path: null };
  }

  /** Readable when the record's unit is inside/above the user's unit, or the case currently sits inside it. */
  async canRead(user: AuthUser, c: WorkflowCase): Promise<boolean> {
    return unitVisible(user, await this.refOf(c.originUnitId)) || inScope(user, await this.refOf(c.assigneeUnitId));
  }

  async assertReadable(user: AuthUser, c: WorkflowCase): Promise<void> {
    if (!(await this.canRead(user, c))) throw Errors.outOfScope('case');
  }

  /** Actions this user may take now (drives the frontend's approval buttons). */
  async available(user: AuthUser, c: WorkflowCase): Promise<AvailableActionDto[]> {
    if (c.closedAt) return [];
    const def = this.registry.get(c.definition);
    if (!def || !inScope(user, await this.refOf(c.assigneeUnitId))) return [];
    return def.transitions
      .filter(t => t.from.includes(c.status) && can(user, t.permission))
      .map(t => ({ action: t.action, toStatus: t.to, signatureRequired: !!t.signature, commentsRequired: !!t.commentsRequired }));
  }

  /** Legacy approval_actions and workflow_actions for one entity, oldest first. */
  async history(entityType: string, entityId: string): Promise<WorkflowHistoryEntryDto[]> {
    const legacy: WorkflowHistoryEntryDto[] = (await this.legacyApprovals.find({ where: { entityType, entityId }, order: { id: 'ASC' } })).map(a => ({
      source: 'LEGACY', caseId: null, definition: null, level: a.level, action: a.action, fromStatus: null, toStatus: null,
      comments: a.comments, details: a.details ?? null, by: a.userName, at: stamp(a.createdAt)!, signatureId: a.signatureId
    }));
    const cases = await this.forEntity(entityType, entityId);
    const rows = cases.length ? await this.actions.find({ where: { caseId: In(cases.map(c => c.id)) }, order: { id: 'ASC' } }) : [];
    const defOf = new Map(cases.map(c => [c.id, c.definition]));
    const current: WorkflowHistoryEntryDto[] = rows.map(a => ({
      source: 'WORKFLOW', caseId: a.caseId, definition: defOf.get(a.caseId) ?? null, level: a.level, action: a.action, fromStatus: a.fromStatus,
      toStatus: a.toStatus, comments: a.comments, details: a.details, by: a.actorName, at: stamp(a.at)!, signatureId: a.signatureId
    }));
    // stable: legacy rows first on equal timestamps (they predate the engine)
    return [...legacy, ...current].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  }

  /** History through the API: the entity must have a readable case, or be a unit the user can see. */
  async historyFor(user: AuthUser, entityType: string, entityId: string): Promise<WorkflowHistoryEntryDto[]> {
    const cases = await this.forEntity(entityType, entityId);
    if (cases.length) {
      if (!(await Promise.all(cases.map(c => this.canRead(user, c)))).some(Boolean)) throw Errors.outOfScope('record');
    } else {
      const unit = await this.units.findById(entityId);
      if (!unit || unit.type !== entityType) throw Errors.notFound(`Workflow history for ${entityType} ${entityId}`);
      assertUnitVisible(user, await this.refOf(unit.id));
    }
    return this.history(entityType, entityId);
  }

  toDto(c: WorkflowCase): WorkflowCaseDto {
    return {
      id: c.id, definition: c.definition, entityType: c.entityType, entityId: c.entityId, seasonId: c.seasonId, level: c.level, status: c.status,
      assigneeUnitId: c.assigneeUnitId, originUnitId: c.originUnitId, dueAt: c.dueAt ? c.dueAt.toISOString() : null,
      escalationLevel: c.escalationLevel, version: c.version, closed: !!c.closedAt
    };
  }

  // ------------------------------------------------------------------ deadlines (scheduler)

  /**
   * Overdue open cases: escalate one unit up (definitions with `escalation`) or remind the assignee daily.
   * Each case is handled in its own transaction so one failure does not block the rest.
   */
  async processDeadlines(now = new Date()): Promise<{ reminders: number; escalations: number }> {
    const out = { reminders: 0, escalations: 0 };
    const names = this.registry.names();
    if (!names.length) return out;
    const due = await this.cases.find({ where: { closedAt: IsNull(), dueAt: LessThanOrEqual(now), definition: In(names) }, order: { dueAt: 'ASC' }, take: 500 });
    for (const c0 of due) {
      try {
        const escalated = await this.ds.transaction(async tx => {
          const c = await tx.getRepository(WorkflowCase).findOne({ where: { id: c0.id }, lock: { mode: 'pessimistic_write' } });
          if (!c || c.closedAt || !c.dueAt || c.dueAt > now) return null;
          const def = this.definitionOf(c.definition);
          const esc = def.escalation;
          if (esc && c.escalationLevel < esc.maxLevel) {
            const level = c.escalationLevel + 1;
            const target = await this.ancestorOf(c.assigneeUnitId, level, tx);
            await tx.getRepository(WorkflowCase).update({ id: c.id }, { escalationLevel: level, dueAt: addHours(now, esc.everyHours), version: c.version + 1 });
            await this.logAction(tx, {
              caseId: c.id, action: 'ESCALATE', fromStatus: c.status, toStatus: c.status, level: c.level, actorId: null, actorName: SYSTEM,
              comments: null, details: { escalationLevel: level, notifiedUnitId: target }, signatureId: null
            });
            // the supervising unit's officers (field roles share the unit type's name; the country level is MoA)
            const targetType = (await this.units.byId(target, tx)).type;
            await this.notifications.notify({
              role: targetType === 'COUNTRY' ? 'MOA' : targetType, unitId: targetType === 'COUNTRY' ? null : target,
              title: `Escalation: ${c.definition} overdue`, link: `/workflow/cases/${c.id}`,
              channels: [...new Set([...(def.notifyChannels ?? DEFAULT_NOTIFY_CHANNELS), 'EMAIL' as const])],
              message: `${c.entityType} ${c.entityId} has been ${c.status} at ${c.assigneeUnitId} past its deadline (escalation level ${level})`
            }, tx);
            await this.events.publish(new WorkflowEscalated(c.id, c.definition, level, target), tx);
            return true;
          }
          await tx.getRepository(WorkflowCase).update({ id: c.id }, { dueAt: addHours(now, REMINDER_EVERY_HOURS) });
          await this.notifyRoles(def, c, c.assigneeUnitId, `Reminder: ${c.definition}`, `${c.entityType} ${c.entityId} is waiting for action (${c.status})`, tx);
          return false;
        });
        if (escalated === true) out.escalations++;
        else if (escalated === false) out.reminders++;
      } catch (e) {
        this.logger.error(`Deadline processing failed for ${c0.id}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** The unit `levels` steps above `unitId` (stops at the country). */
  private async ancestorOf(unitId: string, levels: number, m: EntityManager): Promise<string> {
    let id = unitId;
    for (let i = 0; i < levels; i++) {
      const parent = (await this.units.byId(id, m)).parentId;
      if (!parent) break;
      id = parent;
    }
    return id;
  }

  /** Appends to the write-once action log. */
  private async logAction(m: EntityManager, row: Omit<WorkflowAction, 'id' | 'at'>): Promise<void> {
    const repo = m.getRepository(WorkflowAction);
    await repo.insert(repo.create(row));
  }

  // ------------------------------------------------------------------ notifications

  /** Tell the roles that can act next (at the new assignee unit). */
  private async notifyAssignee(def: WorkflowDefinition, c: WorkflowCase, m: EntityManager) {
    await this.notifyRoles(def, c, c.assigneeUnitId, `${def.name}: ${c.status}`, `${c.entityType} ${c.entityId} is waiting for your action`, m);
  }

  /**
   * Notifications are addressed to (base role, unit). The roles are those granted a permission of the next possible
   * actions; national roles are only addressed when the case sits at the country level.
   */
  private async notifyRoles(def: WorkflowDefinition, c: WorkflowCase, unitId: string, title: string, message: string, m: EntityManager) {
    const perms = [...new Set(def.transitions.filter(t => t.from.includes(c.status)).map(t => t.permission))];
    if (!perms.length) return;
    const rows: Array<{ base: string }> = await m.query(
      `SELECT DISTINCT COALESCE(r.base_role, r.id) AS base FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key = ANY($1) AND r.active`,
      [perms]
    );
    const unit = await this.units.findById(unitId, m);
    const national = unit?.type === 'COUNTRY';
    for (const { base } of rows) {
      if (NATIONAL_ROLES.includes(base) !== national) continue;
      await this.notifications.notify(
        { role: base, unitId: national ? null : unitId, title, message, link: `/workflow/cases/${c.id}`, channels: [...(def.notifyChannels ?? DEFAULT_NOTIFY_CHANNELS)] },
        m
      );
    }
  }
}
