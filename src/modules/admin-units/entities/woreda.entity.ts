import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { Zone } from './zone.entity';
import { Kebele } from './kebele.entity';

@Entity('woredas')
export class Woreda {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  zoneId: string;

  @ManyToOne(() => Zone, z => z.woredas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'zone_id' })
  zone: Zone;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 30, default: 'PENDING' })
  status: string;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @OneToMany(() => Kebele, k => k.woreda)
  kebeles: Kebele[];
}
