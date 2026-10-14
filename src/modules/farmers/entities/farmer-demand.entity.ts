import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Farmer } from './farmer.entity';

/** status: PENDING_REVIEW | FLAGGED_ANOMALY | APPROVED | REJECTED | REVISION_REQUESTED */
@Entity('farmer_demands')
@Unique(['farmerId', 'type'])
export class FarmerDemand {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20 })
  farmerId: string;

  @ManyToOne(() => Farmer, f => f.demands, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'farmer_id' })
  farmer: Farmer;

  @Column({ type: 'varchar', length: 20 }) type: string;
  @Column({ type: 'double precision' }) requestedQtl: number;
  @Column({ type: 'double precision' }) recommendedQtl: number;
  @Column({ type: 'double precision', nullable: true }) approvedQtl: number | null;
  @Column({ type: 'varchar', length: 30, default: 'PENDING_REVIEW' }) status: string;
  @Column({ type: 'text', nullable: true }) reviewComment: string | null;
}
