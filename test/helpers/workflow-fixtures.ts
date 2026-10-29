// Test-only workflow definitions: the engine ships without business workflows (roadmap phases register those).
import { WorkflowRegistry } from '../../src/modules/workflow/workflow.registry';
import { WorkflowDefinition } from '../../src/modules/workflow/workflow.types';

/** Per unit + season: woreda → zone, with return to the woreda, deadline and escalation. */
export const TEST_PACKAGE: WorkflowDefinition = {
  name: 'TEST_PACKAGE_REVIEW',
  shape: 'UNIT_SEASON',
  initialStatus: 'PENDING_WOREDA',
  terminal: ['APPROVED'],
  transitions: [
    { action: 'FORWARD', from: ['PENDING_WOREDA'], to: 'PENDING_ZONE', permission: 'woreda:review', signature: true, assign: 'PARENT' },
    { action: 'RETURN', from: ['PENDING_ZONE'], to: 'PENDING_WOREDA', permission: 'zone:review', commentsRequired: true, assign: 'ORIGIN' },
    { action: 'APPROVE', from: ['PENDING_ZONE'], to: 'APPROVED', permission: 'zone:review', signature: true }
  ],
  deadlineHours: { PENDING_WOREDA: 48, PENDING_ZONE: 48 },
  escalation: { everyHours: 24, maxLevel: 2 }
};

/** Per record: a kebele decision, reminders only. */
export const TEST_RECORD: WorkflowDefinition = {
  name: 'TEST_RECORD_REVIEW',
  shape: 'RECORD',
  entityType: 'TEST_RECORD',
  initialStatus: 'PENDING',
  terminal: ['APPROVED', 'REJECTED'],
  transitions: [
    { action: 'APPROVE', from: ['PENDING'], to: 'APPROVED', permission: 'kebele:review' },
    { action: 'REJECT', from: ['PENDING'], to: 'REJECTED', permission: 'kebele:review', commentsRequired: true }
  ],
  deadlineHours: { PENDING: 24 }
};

export function registerTestWorkflows(registry: WorkflowRegistry): void {
  registry.register(TEST_PACKAGE);
  registry.register(TEST_RECORD);
}
