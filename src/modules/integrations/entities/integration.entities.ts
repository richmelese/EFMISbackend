import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// Read-only partner feeds (Section 3 Integration Framework). MoA consumes; only the source institution writes.

/** EABC tender / contract / LC / forex status (REQ-INT-001) */
@Entity('tenders')
export class Tender {
  @PrimaryColumn({ type: 'varchar', length: 60 }) tenderNo: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) stage: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) deadline: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) budgetAllocatedEtb: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) forexRequiredUsd: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) forexStatus: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) lcIssuingBank: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) lcStatus: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) lowestBidder: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) complianceStatus: string | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Vessel tracking (REQ-INT-001 delivery schedule / Section 3.3) */
@Entity('vessels')
export class Vessel {
  @PrimaryColumn({ type: 'varchar', length: 20 }) imo: string;
  @Column({ type: 'varchar', length: 160 }) name: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) cargo: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) origin: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) laycan: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) etaDjibouti: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) berthingStatus: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) unloadingRateTpd: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) demurrageRisk: string | null;
  @Column({ type: 'jsonb', default: () => `'[]'` }) destinationDepots: string[];
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** ECAE lab inspection / CoC (REQ-INT-002). `data` holds product-specific lab parameters as received. */
@Entity('quality_inspections')
export class QualityInspection {
  @PrimaryColumn({ type: 'varchar', length: 40 }) sampleId: string;
  @Column({ type: 'jsonb' }) data: any;
  /** PASSED_CONFORMITY | REJECTED_IMPOUNDED | HOLD | PENDING */
  @Column({ type: 'varchar', length: 30 }) verdict: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) inspectionDate: string | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

// Trucks/GPS and warehouses now live in the Logistics module (modules/logistics/fleet, modules/logistics/warehouses).

@Entity('logistics_bottlenecks')
export class LogisticsBottleneck {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 200 }) location: string;
  @Column({ type: 'double precision' }) delayHours: number;
  @Column({ type: 'text', nullable: true }) cause: string | null;
}

/** ECX market prices (REQ-INT-004) */
@Entity('ecx_prices')
export class EcxPrice {
  @PrimaryColumn({ type: 'varchar', length: 160 }) commodity: string;
  @Column({ type: 'double precision' }) priceEtbPerQtl: number;
  @Column({ type: 'varchar', length: 20, nullable: true }) trend: string | null;
  @Column({ type: 'int', default: 0 }) sort: number;
}
