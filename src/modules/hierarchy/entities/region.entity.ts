import { Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import { Zone } from './zone.entity';

@Entity('regions')
export class Region {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 4, unique: true })
  code: string;

  @Column({ type: 'double precision', default: 0 })
  sharePercent: number;

  @Column({ type: 'double precision', default: 0 })
  grossDemandMt: number;

  @Column({ type: 'double precision', default: 0 })
  quotaAllocationMt: number;

  @Column({ type: 'int', default: 0 })
  registeredFarmers: number;

  @Column({ type: 'varchar', length: 60, default: 'Pending Regional Signoff' })
  approvalStatus: string;

  @Column({ type: 'text', nullable: true })
  soilDeficiency: string | null;

  /** Quota factor inputs (REQ-1.4-001) */
  @Column({ type: 'double precision', default: 0 })
  historicalUptakeMt: number;

  @Column({ type: 'double precision', default: 1 })
  soilNeedIndex: number;

  @Column({ type: 'double precision', default: 0 })
  creditArrearsEtb: number;

  /** REQ-1.1-001: farm size maximum, configurable per region */
  @Column({ type: 'double precision', default: 50 })
  maxFarmSizeHa: number;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @OneToMany(() => Zone, z => z.region)
  zones: Zone[];
}
