import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Immutable log of workflow actions (UPDATE / DELETE / TRUNCATE blocked by a database trigger, like audit_log).
 * System actions (OPEN by a job, ESCALATE) have no actor id.
 */
@Entity('workflow_actions')
@Index('IDX_workflow_actions_case', ['caseId'])
export class WorkflowAction {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  caseId: string;

  @Column({ type: 'varchar', length: 30 })
  action: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  fromStatus: string | null;

  @Column({ type: 'varchar', length: 30 })
  toStatus: string;

  /** Unit type the case was at when the action was taken */
  @Column({ type: 'varchar', length: 20 })
  level: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', length: 160 })
  actorName: string;

  @Column({ type: 'text', nullable: true })
  comments: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details: any;

  @Column({ type: 'varchar', length: 40, nullable: true })
  signatureId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}
