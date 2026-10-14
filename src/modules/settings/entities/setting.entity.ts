import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Key/value runtime configuration (configurable thresholds, system metadata, summaries). */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  key: string;

  @Column({ type: 'jsonb' })
  value: any;

  @Column({ type: 'varchar', length: 160, nullable: true })
  updatedBy: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
