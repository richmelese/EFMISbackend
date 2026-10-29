import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Cached NSIS soil fertility profile per region (REQ-1.3-002 / REQ-1.5-001 fallback cache). */
@Entity('nsis_soil_profiles')
export class NsisSoilProfile {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  regionId: string;

  @Column({ type: 'double precision' }) nDeficiencyPct: number;
  @Column({ type: 'double precision' }) pDeficiencyPct: number;
  @Column({ type: 'double precision' }) sDeficiencyPct: number;
  @Column({ type: 'double precision' }) bDeficiencyPct: number;
  @Column({ type: 'double precision' }) znDeficiencyPct: number;
  @Column({ type: 'double precision' }) kDeficiencyPct: number;
  @Column({ type: 'double precision' }) acidicAreaPct: number;
  @Column({ type: 'double precision' }) avgPh: number;
  @Column({ type: 'double precision' }) organicMatterPct: number;
  @Column({ type: 'varchar', length: 20 }) droughtRisk: string;
  @Column({ type: 'double precision' }) rainfallAnomalyPct: number;
  @Column({ type: 'double precision' }) recommendedNpsbKgHa: number;
  @Column({ type: 'double precision' }) recommendedUreaKgHa: number;
  @Column({ type: 'varchar', length: 10 }) confidence: string;
  @Column({ type: 'double precision' }) verifiedPct: number;
  @Column({ type: 'int' }) soilCores: number;
  @Column({ type: 'varchar', length: 30 }) dataVersion: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
