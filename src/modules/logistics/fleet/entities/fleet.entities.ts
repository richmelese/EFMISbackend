import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { QTY } from '../../../../common/utils/decimal';

/** Vehicle type: capacity range, licence classes allowed to drive it, cargo it may carry. */
@Entity('vehicle_types')
export class VehicleType {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 30 }) code: string;
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column(QTY()) maxCapacityValue: number;
  @Column({ type: 'varchar', length: 10, default: 'MT' }) capacityUnit: string;
  /** Licence classes permitted to drive this vehicle type, e.g. ["C", "CE"] */
  @Column({ type: 'jsonb', default: () => `'[]'` }) allowedLicenceClasses: string[];
  /** Cargo categories it may carry, e.g. ["BAGGED_FERTILIZER", "BULK"] ([] = any) */
  @Column({ type: 'jsonb', default: () => `'[]'` }) cargoTypes: string[];
  @Column({ type: 'boolean', default: true }) active: boolean;
}

/**
 * Truck (Logistics doc §8.1). Operational status is separate from availability and from GPS connectivity.
 * operationalStatus: ACTIVE | MAINTENANCE | OUT_OF_SERVICE
 * availabilityStatus: AVAILABLE | RESERVED | ON_TRIP
 * Current position columns are the durable "last known position" (Redis holds the hot copy).
 */
@Entity('trucks')
export class Truck {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** Fleet reference used across the UI, e.g. ESLSE-TRK-8819 */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40 }) fleetCode: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 30 }) plateNumber: string;
  @Column({ type: 'uuid' }) vehicleTypeId: string;
  @Column(QTY()) capacityValue: number;
  @Column({ type: 'varchar', length: 10, default: 'MT' }) capacityUnit: string;
  /** ESLSE | EABC | PRIVATE_TRANSPORTER | UNION */
  @Column({ type: 'varchar', length: 30, default: 'ESLSE' }) ownership: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) transporterName: string | null;
  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' }) operationalStatus: string;
  @Column({ type: 'varchar', length: 12, default: 'AVAILABLE' }) availabilityStatus: string;
  @Column({ type: 'double precision', nullable: true }) lastLat: number | null;
  @Column({ type: 'double precision', nullable: true }) lastLng: number | null;
  @Column({ type: 'double precision', nullable: true }) lastSpeedKmh: number | null;
  @Column({ type: 'double precision', nullable: true }) lastHeading: number | null;
  @Column({ type: 'timestamptz', nullable: true }) lastPositionAt: Date | null;
  /** Since when the truck has been stationary (speed < 3 km/h); used by stationary alerts */
  @Column({ type: 'timestamptz', nullable: true }) stationarySince: Date | null;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/**
 * GPS device registry (Teltonika tracker reporting through the GPS Tracking Platform).
 * deviceStatus: REGISTERED | ACTIVE | RETIRED ; connectivity (ONLINE | STALE | OFFLINE | NEVER_SEEN) is telemetry, derived from lastSeenAt.
 */
@Entity('gps_devices')
@Unique('uq_gps_provider_device', ['provider', 'providerDeviceId'])
export class GpsDevice {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** TRACCAR (GPS Tracking Platform) */
  @Column({ type: 'varchar', length: 20, default: 'TRACCAR' }) provider: string;
  /** Device id / unique id as known by the GPS platform */
  @Column({ type: 'varchar', length: 60 }) providerDeviceId: string;
  /** Restricted */
  @Index({ unique: true, where: 'imei IS NOT NULL' }) @Column({ type: 'varchar', length: 20, nullable: true }) imei: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) model: string | null;
  /** Restricted */
  @Column({ type: 'varchar', length: 20, nullable: true }) simNumber: string | null;
  /** One device per truck at a time */
  @Index({ unique: true, where: 'truck_id IS NOT NULL' }) @Column({ type: 'uuid', nullable: true }) truckId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'REGISTERED' }) deviceStatus: string;
  /** Telemetry connectivity, maintained by the stale/offline job: ONLINE | STALE | OFFLINE | NEVER_SEEN */
  @Column({ type: 'varchar', length: 12, default: 'NEVER_SEEN' }) connectivity: string;
  @Column({ type: 'timestamptz', nullable: true }) lastSeenAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) lastPositionRecordedAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Audited pair/unpair history of device ↔ truck. */
@Entity('gps_device_assignments')
@Index(['deviceId'])
export class GpsDeviceAssignment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) deviceId: string;
  @Column({ type: 'uuid' }) truckId: string;
  @Column({ type: 'timestamptz' }) assignedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) unassignedAt: Date | null;
  @Column({ type: 'varchar', length: 160 }) assignedBy: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) unassignedBy: string | null;
  @Column({ type: 'text', nullable: true }) reason: string | null;
}

/**
 * Location history (append-only). Idempotency: (deviceId, providerPositionId) is unique; when the provider gives no
 * position id, (truckId, recordedAt) is unique. Out-of-order points are stored but never move the current position back.
 */
@Entity('truck_locations')
@Index(['truckId', 'recordedAt'])
@Index(['deviceId', 'recordedAt'])
@Index('uq_truck_location_provider', ['deviceId', 'providerPositionId'], { unique: true, where: 'provider_position_id IS NOT NULL' })
@Index('uq_truck_location_time', ['truckId', 'recordedAt'], { unique: true, where: 'provider_position_id IS NULL' })
export class TruckLocation {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' }) id: string;
  @Column({ type: 'uuid' }) truckId: string;
  @Column({ type: 'uuid', nullable: true }) deviceId: string | null;
  @Column({ type: 'uuid', nullable: true }) tripId: string | null;
  @Column({ type: 'double precision' }) latitude: number;
  @Column({ type: 'double precision' }) longitude: number;
  @Column({ type: 'double precision', nullable: true }) speedKmh: number | null;
  @Column({ type: 'double precision', nullable: true }) heading: number | null;
  @Column({ type: 'timestamptz' }) recordedAt: Date;
  @Column({ type: 'timestamptz' }) receivedAt: Date;
  /** TRACCAR_WEBHOOK | TRACCAR_POLL | PARTNER_FEED | SIMULATOR | MANUAL */
  @Column({ type: 'varchar', length: 20 }) source: string;
  @Column({ type: 'varchar', length: 60, nullable: true }) providerPositionId: string | null;
  /** Stored but the current position was NOT updated (older than the last accepted point) */
  @Column({ type: 'boolean', default: false }) outOfOrder: boolean;
  @Column({ type: 'jsonb', nullable: true }) attributes: Record<string, unknown> | null;
}

/** Rejected / unmatched GPS messages for diagnostics (unknown device, invalid coordinates, future timestamp…). */
@Entity('gps_ingest_rejections')
@Index(['providerDeviceId'])
export class GpsIngestRejection {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' }) id: string;
  @Column({ type: 'varchar', length: 20 }) source: string;
  @Column({ type: 'varchar', length: 60, nullable: true }) providerDeviceId: string | null;
  /** UNKNOWN_DEVICE | DEVICE_UNASSIGNED | INVALID_COORDINATES | INVALID_TIMESTAMP | DEVICE_RETIRED */
  @Column({ type: 'varchar', length: 30 }) reason: string;
  @Column({ type: 'jsonb', nullable: true }) payload: unknown;
  @CreateDateColumn({ type: 'timestamptz' }) receivedAt: Date;
}
