import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Immutable workflow action log for approvals at every level (REQ-1.1-007, 1.2-003/004/007 audit trail).
 * UPDATE/DELETE are blocked by a database trigger (see migration).
 * entityType: FARMER | WOREDA | ZONE | REGION
 * action: APPROVE | REJECT | REQUEST_REVISION | PARTIAL_APPROVE | RETURN | HOLD | DISPUTE
 */
@Entity('approval_actions')
@Index(['entityType', 'entityId'])
export class ApprovalAction {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 20 }) entityType: string;
  @Column({ type: 'varchar', length: 40 }) entityId: string;
  @Column({ type: 'varchar', length: 20 }) level: string;
  @Column({ type: 'varchar', length: 30 }) action: string;
  @Column({ type: 'text', nullable: true }) comments: string | null;
  @Column({ type: 'jsonb', nullable: true }) details: any;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) userName: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
