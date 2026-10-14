import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Versioned demand adjustment with mandatory justification (REQ-1.2-003/004). level: WOREDA | ZONE ; unitType: KEBELE | WOREDA */
@Entity('demand_adjustments')
@Index(['unitId'])
export class DemandAdjustment {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 20 }) level: string;
  @Column({ type: 'varchar', length: 20 }) unitType: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) unitId: string | null;
  @Column({ type: 'varchar', length: 160 }) unitName: string;
  @Column({ type: 'double precision' }) rawMt: number;
  @Column({ type: 'double precision' }) adjustedMt: number;
  @Column({ type: 'double precision' }) changePct: number;
  @Column({ type: 'text' }) justification: string;
  @Column({ type: 'int', default: 1 }) version: number;
  @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) authorName: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
