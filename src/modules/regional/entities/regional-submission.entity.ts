import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** Versioned regional demand package submitted to MoA (REQ-1.2-007). status: SUBMITTED | RECEIVED | ACKNOWLEDGED | RETURNED */
@Entity('regional_submissions')
@Index(['regionId', 'version'], { unique: true })
export class RegionalSubmission {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40 }) regionId: string;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'varchar', length: 20 }) status: string;
  @Column({ type: 'varchar', length: 60, unique: true }) receiptNo: string;
  @Column({ type: 'jsonb' }) payload: any;
  @Column({ type: 'jsonb' }) dataQuality: any;
  @Column({ type: 'text', nullable: true }) finalComments: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) submittedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) acknowledgedAt: Date | null;
}
