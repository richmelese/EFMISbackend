import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

// Daily operational reports (frontend Daily Reports Hub).

/** Report date in the Ethiopian calendar, e.g. "03.04.2016" */
@Entity('daily_summary_dates')
export class DailySummaryDate {
  @PrimaryColumn({ type: 'varchar', length: 12 }) id: string;
  @Column({ type: 'varchar', length: 60 }) label: string;
  @Column({ type: 'int' }) sort: number;
}

/** Daily Fertilizer Summary row: date x region x fertilizer type */
@Entity('daily_summary_records')
export class DailySummaryRecord {
  @PrimaryColumn({ type: 'varchar', length: 12 }) dateId: string;
  @PrimaryColumn({ type: 'varchar', length: 40 }) regionId: string;
  @PrimaryColumn({ type: 'varchar', length: 20 }) fertilizerType: string;
  @Column({ type: 'varchar', length: 120 }) regionName: string;
  @Column({ type: 'double precision', default: 0 }) procuredMt: number;
  @Column({ type: 'double precision', default: 0 }) regionalStockMt: number;
  @Column({ type: 'double precision', default: 0 }) dispatchedMt: number;
  @Column({ type: 'double precision', default: 0 }) portCumulativeMt: number;
  @Column({ type: 'double precision', default: 0 }) portDailyMt: number;
  @Column({ type: 'double precision', default: 0 }) currentRegionStockMt: number;
  @Column({ type: 'double precision', default: 0 }) deliveredToRegionMt: number;
  @Column({ type: 'double precision', default: 0 }) queueMt: number;
  @Column({ type: 'double precision', default: 0 }) hubThisWeekMt: number;
  @Column({ type: 'double precision', default: 0 }) hubCumulativeMt: number;
  @Column({ type: 'int', default: 0 }) sort: number;
  @Column({ type: 'varchar', length: 160, nullable: true }) updatedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) updatedAt: Date | null;
}

@Entity('report_regions')
export class ReportRegion {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) amharic: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) color: string | null;
  @Column({ type: 'int' }) sort: number;
}

/** Vessel lot dispatched to a region's unions */
@Entity('vessel_lots')
@Index(['regionId'])
export class VesselLot {
  @PrimaryColumn({ type: 'varchar', length: 40 }) lotId: string;
  @Column({ type: 'varchar', length: 40 }) regionId: string;
  @Column({ type: 'varchar', length: 200 }) vesselName: string;
  @Column({ type: 'varchar', length: 20 }) fertilizerType: string;
  @Column({ type: 'varchar', length: 40 }) status: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) lotCode: string | null;
  @Column({ type: 'jsonb', default: () => `'[]'` }) dateColumns: string[];
  @Column({ type: 'int', default: 0 }) sort: number;
}

/** Union share within a lot. id is "<lotId>:<unionShortId>" (frontend ids like "u1" are unique per lot only). */
@Entity('lot_unions')
@Index(['lotId'])
export class LotUnion {
  @PrimaryColumn({ type: 'varchar', length: 80 }) id: string;
  @Column({ type: 'varchar', length: 40 }) lotId: string;
  @Column({ type: 'varchar', length: 160 }) unionName: string;
  @Column({ type: 'varchar', length: 160 }) destination: string;
  @Column({ type: 'double precision', default: 0 }) shareMt: number;
  @Column({ type: 'int', default: 0 }) sort: number;
}

@Entity('union_daily_loads')
export class UnionDailyLoad {
  @PrimaryColumn({ type: 'varchar', length: 80 }) unionId: string;
  @PrimaryColumn({ type: 'varchar', length: 12 }) date: string;
  @Column({ type: 'double precision', default: 0 }) mt: number;
}

@Entity('dispatch_waybills')
export class DispatchWaybill {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 40 }) lotId: string;
  @Column({ type: 'varchar', length: 80 }) unionId: string;
  @Column({ type: 'varchar', length: 12 }) date: string;
  @Column({ type: 'double precision' }) mt: number;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40 }) waybillNo: string;
  @Column({ type: 'varchar', length: 30, nullable: true }) truckPlate: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) driverName: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
