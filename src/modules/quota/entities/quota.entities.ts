import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Provisional quota computation run (REQ-1.4-001). status: PROVISIONAL | PUBLISHED | SUPERSEDED | SCENARIO */
@Entity('quota_runs')
export class QuotaRun {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40 }) season: string;
  @Column({ type: 'varchar', length: 30 }) algorithmVersion: string;
  @Column({ type: 'jsonb' }) weights: { historical: number; soilIndex: number; arrearsPenalty: number };
  @Column({ type: 'double precision' }) nationalTotalMt: number;
  @Column({ type: 'jsonb' }) results: any;
  @Column({ type: 'varchar', length: 12 }) status: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) label: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/**
 * Regional request to adjust the provisional quota (REQ-1.4-002).
 * status: SUBMITTED | UNDER_REVIEW | APPROVED | PARTIALLY_APPROVED | REJECTED | APPEALED | APPEAL_APPROVED | APPEAL_REJECTED
 */
@Entity('quota_adjustment_requests')
@Index(['regionId'])
export class QuotaAdjustmentRequest {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40 }) regionId: string;
  @Column({ type: 'varchar', length: 10 }) direction: 'INCREASE' | 'DECREASE';
  @Column({ type: 'double precision' }) amountMt: number;
  @Column({ type: 'varchar', length: 40 }) justificationType: string;
  @Column({ type: 'text' }) justification: string;
  @Column({ type: 'jsonb', default: () => `'[]'` }) evidence: Array<{ name: string; url?: string; documentId?: string }>;
  @Column({ type: 'varchar', length: 20, default: 'SUBMITTED' }) status: string;
  @Column({ type: 'double precision', nullable: true }) decisionMt: number | null;
  @Column({ type: 'text', nullable: true }) decisionComments: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) decidedBy: string | null;
  @Column({ type: 'text', nullable: true }) appealReason: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/**
 * A quota line at any level of the downward cascade (REQ-1.4-004/005/007).
 * level: REGION | ZONE | WOREDA | KEBELE | PC
 * status: Planned | Scheduled Dispatch | In Transit | Delivered | Partially Delivered | Region/Zone/Woreda/Kebele Signed
 */
@Entity('quota_allocations')
@Index(['regionId'])
@Index(['parentId'])
export class QuotaAllocation {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 10 }) level: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) parentId: string | null;
  @Column({ type: 'varchar', length: 40 }) regionId: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) unitId: string | null;
  @Column({ type: 'varchar', length: 200 }) recipientName: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) recipientNameAm: string | null;
  @Column({ type: 'varchar', length: 40 }) season: string;
  @Column({ type: 'double precision', default: 0 }) npsbMt: number;
  @Column({ type: 'double precision', default: 0 }) ureaMt: number;
  @Column({ type: 'double precision', default: 0 }) otherMt: number;
  @Column({ type: 'varchar', length: 200, nullable: true }) allocationSource: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) deliveryWindow: string | null;
  @Column({ type: 'varchar', length: 30 }) status: string;
  @Column({ type: 'double precision', default: 0 }) receivedMt: number;
  /** Pending | Reconciled | Discrepancy */
  @Column({ type: 'varchar', length: 20, default: 'Pending' }) reconciliationStatus: string;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  /** PENDING | APPROVED */
  @Column({ type: 'varchar', length: 10, default: 'PENDING' }) approvalStatus: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) acknowledgedBy: string | null;
  @Column({ type: 'int', default: 1 }) version: number;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'int', default: 0 }) sort: number;
}

/** Formal amendment with immutable before-state and approval (REQ-1.4-009). status: PENDING_APPROVAL | APPROVED | REJECTED */
@Entity('quota_amendments')
@Index(['allocationId'])
export class QuotaAmendment {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40 }) allocationId: string;
  @Column({ type: 'varchar', length: 40 }) amendmentType: string;
  @Column({ type: 'jsonb' }) beforeState: any;
  @Column({ type: 'jsonb' }) proposedState: any;
  @Column({ type: 'text' }) justification: string;
  @Column({ type: 'jsonb', default: () => `'[]'` }) evidence: any[];
  @Column({ type: 'jsonb', nullable: true }) impact: any;
  @Column({ type: 'varchar', length: 20, default: 'PENDING_APPROVAL' }) status: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) requestedBy: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) decidedBy: string | null;
  @Column({ type: 'text', nullable: true }) decisionComments: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) decidedAt: Date | null;
}

/** Electronic quota letter to a regional bureau (REQ-1.4-006). status: SENT | DELIVERED | READ | ACKNOWLEDGED */
@Entity('quota_letters')
export class QuotaLetter {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40, unique: true }) controlNo: string;
  @Column({ type: 'varchar', length: 40 }) regionId: string;
  @Column({ type: 'varchar', length: 40 }) season: string;
  @Column({ type: 'jsonb' }) content: any;
  @Column({ type: 'varchar', length: 14, default: 'SENT' }) status: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) readAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) acknowledgedAt: Date | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) acknowledgedBy: string | null;
}

/**
 * Automatic procurement request / PO to EABC (REQ-1.4-010).
 * status: GENERATED | SENT | RECEIVED | ACKNOWLEDGED | PROCESSING | CLARIFICATION_REQUESTED
 */
@Entity('purchase_orders')
export class PurchaseOrder {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40, unique: true }) controlNo: string;
  @Column({ type: 'varchar', length: 40 }) season: string;
  @Column({ type: 'jsonb' }) payload: any;
  @Column({ type: 'varchar', length: 30 }) status: string;
  /** URGENT | STANDARD | SCHEDULED */
  @Column({ type: 'varchar', length: 12, default: 'STANDARD' }) priority: string;
  @Column({ type: 'jsonb', default: () => `'[]'` }) history: Array<{ status: string; at: string; by: string; note?: string | null }>;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
