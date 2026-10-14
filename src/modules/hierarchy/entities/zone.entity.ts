import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { Region } from './region.entity';
import { Woreda } from './woreda.entity';

/** Review status values: PENDING | APPROVED | PARTIALLY_APPROVED | RETURNED | HELD | DISPUTED | SUBMITTED */
@Entity('zones')
export class Zone {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  regionId: string;

  @ManyToOne(() => Region, r => r.zones, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'region_id' })
  region: Region;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 30, default: 'PENDING' })
  status: string;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @OneToMany(() => Woreda, w => w.zone)
  woredas: Woreda[];
}
