import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Route with optional road geometry from the routing provider (Logistics doc §12). */
@Entity('routes')
export class Route {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'uuid' }) originWarehouseId: string;
  @Column({ type: 'uuid' }) destinationWarehouseId: string;
  /** Polyline [[lat, lng], ...] (road geometry or planned corridor) */
  @Column({ type: 'jsonb', default: () => `'[]'` }) geometry: Array<[number, number]>;
  @Column({ type: 'double precision', nullable: true }) distanceKm: number | null;
  @Column({ type: 'double precision', nullable: true }) estimatedDurationMin: number | null;
  /** Route-deviation corridor half-width (km) */
  @Column({ type: 'double precision', default: 2 }) corridorWidthKm: number;
  /** ROUTING_PROVIDER | MANUAL | STRAIGHT_LINE */
  @Column({ type: 'varchar', length: 20, default: 'MANUAL' }) geometrySource: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) providerReference: string | null;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @Column({ type: 'varchar', length: 160 }) createdBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Ordered checkpoint on a route; reached when the truck enters its geofence. */
@Entity('route_milestones')
@Index(['routeId', 'sequence'], { unique: true })
export class RouteMilestone {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) routeId: string;
  @Column({ type: 'int' }) sequence: number;
  @Column({ type: 'varchar', length: 160 }) name: string;
  @Column({ type: 'uuid', nullable: true }) geofenceId: string | null;
  /** Expected minutes after trip start */
  @Column({ type: 'int' }) expectedOffsetMin: number;
  /** Tolerance before the milestone is flagged as missed/late */
  @Column({ type: 'int', default: 60 }) toleranceMin: number;
}

/** Per-trip milestone progress. status: PENDING | REACHED | MISSED */
@Entity('trip_milestones')
@Index(['tripId'])
export class TripMilestone {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) tripId: string;
  @Column({ type: 'uuid' }) routeMilestoneId: string;
  @Column({ type: 'int' }) sequence: number;
  @Column({ type: 'varchar', length: 160 }) name: string;
  @Column({ type: 'uuid', nullable: true }) geofenceId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) expectedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) reachedAt: Date | null;
  @Column({ type: 'varchar', length: 10, default: 'PENDING' }) status: string;
}

/**
 * Geofence: CIRCLE (centre + radius) or POLYGON (ring of [lat, lng]).
 * kind: WAREHOUSE | DEPOT | CHECKPOINT | BORDER | PORT | RESTRICTED
 * Hysteresis: a transition is confirmed only after `minConsecutivePoints` agreeing positions.
 */
@Entity('geofences')
export class Geofence {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 160 }) name: string;
  @Column({ type: 'varchar', length: 12 }) kind: string;
  @Column({ type: 'varchar', length: 8 }) shape: 'CIRCLE' | 'POLYGON';
  @Column({ type: 'double precision', nullable: true }) centerLat: number | null;
  @Column({ type: 'double precision', nullable: true }) centerLng: number | null;
  @Column({ type: 'double precision', nullable: true }) radiusM: number | null;
  @Column({ type: 'jsonb', nullable: true }) polygon: Array<[number, number]> | null;
  @Column({ type: 'uuid', nullable: true }) warehouseId: string | null;
  @Column({ type: 'boolean', default: true }) alertOnEnter: boolean;
  @Column({ type: 'boolean', default: true }) alertOnExit: boolean;
  @Column({ type: 'int', default: 2 }) minConsecutivePoints: number;
  @Column({ type: 'boolean', default: true }) active: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Hysteresis state per truck × geofence. */
@Entity('geofence_states')
export class GeofenceState {
  @PrimaryColumn({ type: 'uuid' }) truckId: string;
  @PrimaryColumn({ type: 'uuid' }) geofenceId: string;
  /** Confirmed state */
  @Column({ type: 'boolean', default: false }) inside: boolean;
  /** Consecutive positions disagreeing with the confirmed state */
  @Column({ type: 'int', default: 0 }) pendingCount: number;
  @Column({ type: 'timestamptz', nullable: true }) lastTransitionAt: Date | null;
}

/** Confirmed geofence transitions. type: ENTERED | EXITED */
@Entity('geofence_events')
@Index(['geofenceId', 'occurredAt'])
@Index(['truckId', 'occurredAt'])
export class GeofenceEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) truckId: string;
  @Column({ type: 'uuid' }) geofenceId: string;
  @Column({ type: 'uuid', nullable: true }) tripId: string | null;
  @Column({ type: 'varchar', length: 8 }) type: string;
  @Column({ type: 'double precision' }) latitude: number;
  @Column({ type: 'double precision' }) longitude: number;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
}

/**
 * Other derived tracking events (de-duplicated by dedupeKey).
 * type: ROUTE_DEVIATION | ROUTE_RETURNED | ETA_UPDATED | SHIPMENT_DELAYED | DEVICE_STALE | DEVICE_OFFLINE | DEVICE_ONLINE | STATIONARY | MILESTONE_REACHED | MILESTONE_MISSED
 */
@Entity('tracking_events')
@Index(['truckId', 'occurredAt'])
@Index(['tripId'])
@Index('uq_tracking_event_dedupe', ['dedupeKey'], { unique: true, where: 'dedupe_key IS NOT NULL' })
export class TrackingEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 20 }) type: string;
  @Column({ type: 'uuid', nullable: true }) truckId: string | null;
  @Column({ type: 'uuid', nullable: true }) tripId: string | null;
  @Column({ type: 'uuid', nullable: true }) shipmentId: string | null;
  @Column({ type: 'uuid', nullable: true }) deviceId: string | null;
  @Column({ type: 'jsonb', nullable: true }) payload: Record<string, unknown> | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) dedupeKey: string | null;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
}
