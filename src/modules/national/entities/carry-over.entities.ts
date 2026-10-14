import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Carry-over stock by facility tier (REQ-1.3-004). */
@Entity('carry_over_facilities')
export class CarryOverFacility {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 200 }) facility: string;
  @Column({ type: 'double precision' }) usableMt: number;
  @Column({ type: 'double precision' }) unverifiedMt: number;
  @Column({ type: 'double precision' }) qcPassPercent: number;
  @Column({ type: 'int', default: 0 }) sort: number;
}

/** Carry-over stock by fertilizer type; usable = not expired AND QC passed (REQ-1.3-004). */
@Entity('carry_over_stocks')
export class CarryOverStock {
  @PrimaryColumn({ type: 'varchar', length: 20 }) type: string;
  @Column({ type: 'double precision' }) stockMt: number;
  @Column({ type: 'double precision' }) usableMt: number;
  @Column({ type: 'double precision' }) expiredMt: number;
  @Column({ type: 'varchar', length: 200 }) qcStatus: string;
  @Column({ type: 'int', default: 0 }) sort: number;
  @Column({ type: 'varchar', length: 160, nullable: true }) updatedBy: string | null;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
