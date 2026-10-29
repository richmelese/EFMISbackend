import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { SeasonStatus, SeasonType } from '../season-calendar';

/** Agricultural season (Meher / Belg / Irrigation). Demand, quota and totals are recorded per season. */
@Entity('seasons')
@Index('UQ_seasons_type_year', ['type', 'year'], { unique: true })
@Index('UQ_seasons_current', ['isCurrent'], { unique: true, where: 'is_current' })
@Check('CHK_seasons_type', `type IN ('MEHER', 'BELG', 'IRRIGATION')`)
@Check('CHK_seasons_status', `status IN ('PLANNING', 'OPEN', 'CLOSED')`)
@Check('CHK_seasons_dates', 'ends_on >= starts_on')
export class Season {
  /** e.g. MEHER-2026 */
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  /** Display name used across the system, e.g. "Meher 2026", "Irrigation 2026-27" */
  @Column({ type: 'varchar', length: 60, unique: true })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: SeasonType;

  /** Calendar (Gregorian) year the season starts in */
  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'date' })
  startsOn: string;

  @Column({ type: 'date' })
  endsOn: string;

  /** Last day farmer demand is collected for this season */
  @Column({ type: 'date' })
  collectionDeadline: string;

  @Column({ type: 'varchar', length: 20, default: 'PLANNING' })
  status: SeasonStatus;

  /** The season new records default to (exactly one) */
  @Column({ type: 'boolean', default: false })
  isCurrent: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
