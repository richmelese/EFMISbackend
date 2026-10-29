import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('fertilizer_types')
export class FertilizerType {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  code: string;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  unit: string | null;

  @Column({ type: 'varchar', length: 12, nullable: true })
  color: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;
}
