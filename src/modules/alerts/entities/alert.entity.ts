import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Critical event alert with SLA (REQ-1.2-006, REQ-INT-005).
 * severity: CRITICAL_RED | HIGH_ORANGE | MEDIUM_YELLOW | LOW_BLUE
 * status: OPEN | ACKNOWLEDGED | INVESTIGATING | RESOLVED | CLOSED | SNOOZED
 */
@Entity('alerts')
export class Alert {
  @PrimaryColumn({ type: 'varchar', length: 30 }) id: string;
  @Column({ type: 'varchar', length: 20 }) severity: string;
  @Column({ type: 'varchar', length: 240 }) title: string;
  @Column({ type: 'varchar', length: 80 }) category: string;
  @Column({ type: 'text', nullable: true }) triggerText: string | null;
  @Column({ type: 'varchar', length: 240, nullable: true }) affectedArea: string | null;
  @Column({ type: 'timestamptz', nullable: true }) slaDeadline: Date | null;
  /** ESCALATED_TO_PMO | NOTIFIED_MOA | NOTIFIED_ZONE | NORMAL */
  @Column({ type: 'varchar', length: 30, default: 'NORMAL' }) pmoNotificationStatus: string;
  @Column({ type: 'text', nullable: true }) actionRequired: string | null;
  /** Display timestamp "YYYY-MM-DD HH:mm" */
  @Column({ type: 'varchar', length: 20 }) timestamp: string;
  @Column({ type: 'varchar', length: 20, default: 'OPEN' }) status: string;
  @Column({ type: 'boolean', default: false }) resolved: boolean;
  @Column({ type: 'varchar', length: 160, nullable: true }) assignedTo: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) acknowledgedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) resolvedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @Column({ type: 'text', nullable: true }) resolutionNotes: string | null;
  @Column({ type: 'timestamptz', nullable: true }) snoozedUntil: Date | null;
  @Column({ type: 'text', nullable: true }) snoozeReason: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) sourceType: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) sourceId: string | null;
  /** Prevents automated conditions from raising duplicates */
  @Index({ unique: true, where: 'dedupe_key IS NOT NULL' })
  @Column({ type: 'varchar', length: 160, nullable: true })
  dedupeKey: string | null;
}
