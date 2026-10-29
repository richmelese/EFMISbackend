import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Woreda } from './woreda.entity';

@Entity('kebeles')
export class Kebele {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  woredaId: string;

  @ManyToOne(() => Woreda, w => w.kebeles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'woreda_id' })
  woreda: Woreda;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  daName: string | null;

  @Column({ type: 'int', default: 0 })
  farmers: number;

  /** Approved demand rolled up into the kebele (MT) */
  @Column({ type: 'double precision', default: 0 })
  demandMt: number;

  @Column({ type: 'varchar', length: 30, default: 'PENDING' })
  status: string;

  @Column({ type: 'int', default: 0 })
  sort: number;
}
