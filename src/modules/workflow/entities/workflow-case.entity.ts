import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One running workflow (see WorkflowDefinition). `assigneeUnitId` is the unit that must act next; `level` its type.
 * Unique per definition + entity + season, which covers both shapes (per record; per unit and season).
 */
@Entity('workflow_cases')
@Index('UQ_workflow_cases_entity', ['definition', 'entityType', 'entityId', 'seasonId'], { unique: true })
@Index('IDX_workflow_cases_entity', ['entityType', 'entityId'])
@Index('IDX_workflow_cases_assignee', ['assigneeUnitId'])
export class WorkflowCase {
  /** e.g. WFC-… */
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  entityType: string;

  @Column({ type: 'varchar', length: 60 })
  entityId: string;

  @Column({ type: 'varchar', length: 40 })
  definition: string;

  /** Type of the assignee unit (KEBELE, WOREDA, ZONE, REGION, COUNTRY, …) */
  @Column({ type: 'varchar', length: 20 })
  level: string;

  @Column({ type: 'varchar', length: 30 })
  status: string;

  @Column({ type: 'varchar', length: 40 })
  assigneeUnitId: string;

  /** Unit the case was opened at (the record's unit; target of ORIGIN assignments) */
  @Column({ type: 'varchar', length: 40 })
  originUnitId: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  seasonId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  dueAt: Date | null;

  @Column({ type: 'int', default: 0 })
  escalationLevel: number;

  /** Optimistic concurrency: incremented by every action */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** Set when the case reaches a terminal status */
  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
