import { transitionFor, validateDefinition, WorkflowDefinition } from './workflow.types';

const PACKAGE: WorkflowDefinition = {
  name: 'SAMPLE_PACKAGE', shape: 'UNIT_SEASON', initialStatus: 'PENDING_WOREDA', terminal: ['APPROVED', 'REJECTED'],
  transitions: [
    { action: 'FORWARD', from: ['PENDING_WOREDA'], to: 'PENDING_ZONE', permission: 'woreda:review', assign: 'PARENT' },
    { action: 'RETURN', from: ['PENDING_ZONE'], to: 'PENDING_WOREDA', permission: 'zone:review', commentsRequired: true, assign: 'ORIGIN' },
    { action: 'APPROVE', from: ['PENDING_ZONE'], to: 'APPROVED', permission: 'zone:review', signature: true },
    { action: 'REJECT', from: ['PENDING_WOREDA', 'PENDING_ZONE'], to: 'REJECTED', permission: 'zone:review', commentsRequired: true }
  ],
  deadlineHours: { PENDING_WOREDA: 72 }
};

describe('workflow definitions', () => {
  it('accepts a consistent definition and finds transitions', () => {
    expect(() => validateDefinition(PACKAGE)).not.toThrow();
    expect(transitionFor(PACKAGE, 'PENDING_ZONE', 'RETURN')?.to).toBe('PENDING_WOREDA');
    expect(transitionFor(PACKAGE, 'PENDING_WOREDA', 'APPROVE')).toBeUndefined();
  });

  it.each([
    ['bad name', { name: 'x' }, /UPPER_SNAKE/],
    ['RECORD without entity type', { shape: 'RECORD' }, /entityType/],
    ['transition out of a terminal status', { transitions: [...PACKAGE.transitions, { action: 'REOPEN', from: ['APPROVED'], to: 'PENDING_WOREDA', permission: 'zone:review' }] }, /terminal/],
    ['duplicate action', { transitions: [...PACKAGE.transitions, { action: 'FORWARD', from: ['PENDING_WOREDA'], to: 'APPROVED', permission: 'zone:review' }] }, /twice/],
    ['unreachable status', { terminal: ['APPROVED', 'REJECTED', 'ARCHIVED'] }, /ARCHIVED is unreachable/],
    ['deadline for unknown status', { deadlineHours: { NOPE: 1 } }, /unknown status/]
  ] as const)('rejects %s', (_, change, error) => {
    expect(() => validateDefinition({ ...PACKAGE, ...(change as Partial<WorkflowDefinition>) })).toThrow(error);
  });
});
