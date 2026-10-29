import { Permission } from '../../common/constants/permissions';

/** Where a case is assigned after a transition. */
export type WorkflowAssign =
  /** stays with the current unit */
  | 'SAME'
  /** moves to the parent unit (forward up the chain: woreda → zone → region) */
  | 'PARENT'
  /** goes back to the unit the case was opened at (return for revision) */
  | 'ORIGIN';

export interface WorkflowTransition {
  /** Action code (APPROVE, RETURN, FORWARD, …); the frontend translates it */
  action: string;
  /** Statuses the action is available in */
  from: readonly string[];
  to: string;
  /** Permission the actor needs (any role holding it); the case's unit must also be inside the actor's unit */
  permission: Permission;
  /** E-signature (PIN or password) required */
  signature?: boolean;
  /** Comments / reason required */
  commentsRequired?: boolean;
  assign?: WorkflowAssign;
}

/**
 * A business workflow, registered in code by the domain module that owns the record (WorkflowRegistry.register).
 *  - RECORD:      one case per record (e.g. a farmer's demand for a season)
 *  - UNIT_SEASON: one case per administrative unit and season (e.g. a woreda demand package); entity = the unit
 */
export interface WorkflowDefinition {
  name: string;
  shape: 'RECORD' | 'UNIT_SEASON';
  /** RECORD shape: the record type, e.g. FARMER_DEMAND. UNIT_SEASON cases use the unit type (WOREDA, ZONE, …). */
  entityType?: string;
  initialStatus: string;
  /** Statuses that close the case (no outgoing transitions) */
  terminal: readonly string[];
  transitions: readonly WorkflowTransition[];
  /** Hours the assignee has to act in a status; no entry = no deadline */
  deadlineHours?: Readonly<Record<string, number>>;
  /** After the deadline: escalate one unit up every `everyHours`, at most `maxLevel` times (otherwise daily reminders) */
  escalation?: { everyHours: number; maxLevel: number };
}

/** Published (in the acting transaction) after every transition. Domain modules update their own records from it. */
export class WorkflowAdvanced {
  constructor(
    readonly caseId: string,
    readonly definition: string,
    readonly entityType: string,
    readonly entityId: string,
    readonly action: string,
    readonly fromStatus: string,
    readonly toStatus: string,
    readonly assigneeUnitId: string,
    readonly actorId: string,
    readonly closed: boolean
  ) {}
}

/** Published when the scheduler escalates an overdue case. */
export class WorkflowEscalated {
  constructor(readonly caseId: string, readonly definition: string, readonly escalationLevel: number, readonly notifiedUnitId: string) {}
}

/** Throws when a definition is inconsistent (checked at registration, so mistakes fail at startup / in tests). */
export function validateDefinition(def: WorkflowDefinition): void {
  const fail = (msg: string) => {
    throw new Error(`Workflow ${def.name}: ${msg}`);
  };
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(def.name)) fail('name must be an UPPER_SNAKE code (3-40 chars)');
  if (def.shape === 'RECORD' && !def.entityType) fail('RECORD workflows need an entityType');
  const statuses = new Set([def.initialStatus, ...def.terminal, ...def.transitions.flatMap(t => [...t.from, t.to])]);
  if (def.terminal.includes(def.initialStatus)) fail('the initial status cannot be terminal');
  const seen = new Set<string>();
  for (const t of def.transitions) {
    if (!t.from.length) fail(`${t.action} has no from-status`);
    for (const f of t.from) {
      if (def.terminal.includes(f)) fail(`${t.action} leaves terminal status ${f}`);
      const key = `${f}:${t.action}`;
      if (seen.has(key)) fail(`${t.action} is defined twice from ${f}`);
      seen.add(key);
    }
  }
  const reachable = new Set([def.initialStatus]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of def.transitions) {
      if (t.from.some(f => reachable.has(f)) && !reachable.has(t.to)) {
        reachable.add(t.to);
        grew = true;
      }
    }
  }
  for (const s of statuses) if (!reachable.has(s)) fail(`status ${s} is unreachable`);
  for (const s of Object.keys(def.deadlineHours ?? {})) if (!statuses.has(s)) fail(`deadline for unknown status ${s}`);
}

/** The transition for `action` in `status`, or undefined. */
export const transitionFor = (def: WorkflowDefinition, status: string, action: string): WorkflowTransition | undefined =>
  def.transitions.find(t => t.action === action && t.from.includes(status));
