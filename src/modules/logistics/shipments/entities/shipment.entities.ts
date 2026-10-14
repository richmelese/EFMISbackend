import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { QTY } from '../../../../common/utils/decimal';

/**
 * Shipment = cargo movement request (Logistics doc §9.1).
 * status: DRAFT → PLANNED → ASSIGNED → READY_FOR_DISPATCH → IN_TRANSIT → ARRIVED → DELIVERED → CLOSED
 *         exceptions: ON_HOLD | CANCELLED | DELIVERY_FAILED
 * DELAYED is a flag (isDelayed) driven by ETA events, not a lifecycle state.
 */
@Entity('shipments')
@Index(['status'])
export class Shipment {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** SH-1001 */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 20 }) shipmentNumber: string;
  /** Legal transport document number (entered from the transporter's waybill, or issued at dispatch: WB-2026-000123) */
  @Index({ unique: true, where: 'waybill_number IS NOT NULL' }) @Column({ type: 'varchar', length: 64, nullable: true }) waybillNumber: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) customerName: string | null;
  @Column({ type: 'uuid' }) originWarehouseId: string;
  @Column({ type: 'uuid' }) destinationWarehouseId: string;
  @Column({ type: 'uuid', nullable: true }) productId: string | null;
  @Column({ type: 'text' }) cargoDescription: string;
  @Column(QTY()) plannedQuantity: number;
  @Column({ type: 'varchar', length: 10, default: 'MT' }) quantityUnit: string;
  /** LOW | NORMAL | HIGH | URGENT */
  @Column({ type: 'varchar', length: 10, default: 'NORMAL' }) priority: string;
  @Column({ type: 'timestamptz' }) plannedPickupAt: Date;
  @Column({ type: 'timestamptz' }) plannedDeliveryAt: Date;
  @Column({ type: 'uuid', nullable: true }) routeId: string | null;
  /** Optional link to an EFMIS quota line (QuotaAllocation id) or vessel lot the cargo serves */
  @Column({ type: 'varchar', length: 60, nullable: true }) quotaAllocationId: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) qrLot: string | null;
  @Column({ type: 'varchar', length: 22, default: 'DRAFT' }) status: string;
  /** Status to return to when lifted from ON_HOLD */
  @Column({ type: 'varchar', length: 22, nullable: true }) statusBeforeHold: string | null;
  @Column({ type: 'boolean', default: false }) isDelayed: boolean;
  @Column({ type: 'timestamptz', nullable: true }) estimatedArrivalAt: Date | null;
  /** Stock reserved at origin for this shipment (MT) */
  @Column(QTY({ default: 0 })) reservedQuantity: number;
  @Column(QTY({ nullable: true })) loadedQuantity: number | null;
  @Column(QTY({ default: 0 })) deliveredQuantity: number;
  @Column({ type: 'text', nullable: true }) holdReason: string | null;
  @Column({ type: 'text', nullable: true }) cancelReason: string | null;
  @Column({ type: 'varchar', length: 160 }) createdBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/**
 * Trip = one vehicle journey (§9.2), may carry several shipments (TripShipment).
 * status: PLANNED → DRIVER_ACCEPTED → VEHICLE_CHECKED → LOADING → READY → DISPATCHED → IN_PROGRESS → ARRIVED → UNLOADING → COMPLETED
 *         exceptions: ABORTED | INCIDENT | RETURNING
 * The partial unique index allows ONE active trip per truck (double-booking prevention at DB level).
 */
@Entity('trips')
@Index('uq_truck_active_trip', ['truckId'], { unique: true, where: `status NOT IN ('COMPLETED','ABORTED')` })
@Index(['status'])
export class Trip {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** TR-1001 */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 20 }) tripNumber: string;
  @Column({ type: 'uuid' }) truckId: string;
  @Column({ type: 'uuid' }) primaryDriverId: string;
  @Column({ type: 'uuid', nullable: true }) routeId: string | null;
  @Column({ type: 'timestamptz' }) plannedStartAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) actualStartAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) estimatedArrivalAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) actualArrivalAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ type: 'varchar', length: 20, default: 'PLANNED' }) status: string;
  @Column({ type: 'boolean', default: true }) requiresDriverAcceptance: boolean;
  @Column({ type: 'boolean', default: true }) requiresTracking: boolean;
  /** Distance remaining (km) and last ETA computation, maintained by the ETA processor */
  @Column({ type: 'double precision', nullable: true }) remainingDistanceKm: number | null;
  @Column({ type: 'timestamptz', nullable: true }) etaComputedAt: Date | null;
  @Column({ type: 'double precision', nullable: true }) etaComputedAtLat: number | null;
  @Column({ type: 'double precision', nullable: true }) etaComputedAtLng: number | null;
  /** Consecutive off-corridor points (route deviation hysteresis) */
  @Column({ type: 'int', default: 0 }) offRouteCount: number;
  @Column({ type: 'boolean', default: false }) offRoute: boolean;
  @Column({ type: 'text', nullable: true }) abortReason: string | null;
  @Column({ type: 'varchar', length: 160 }) createdBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/** Trip ↔ shipment join (multi-shipment / multi-stop trips). */
@Entity('trip_shipments')
export class TripShipment {
  @PrimaryColumn({ type: 'uuid' }) tripId: string;
  @PrimaryColumn({ type: 'uuid' }) shipmentId: string;
  /** Drop-off order on multi-stop trips */
  @Column({ type: 'int', default: 1 }) stopSequence: number;
  @Column(QTY({ nullable: true })) loadedQuantity: number | null;
  @Column(QTY({ nullable: true })) loadingDiscrepancy: number | null;
  @Column({ type: 'timestamptz', nullable: true }) loadedAt: Date | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) loadedBy: string | null;
}

/** Pre-trip inspection / checklist and driver acknowledgement (§6 step 10, §10 step 35). */
@Entity('trip_checklists')
@Index(['tripId'])
export class TripChecklist {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) tripId: string;
  /** e.g. [{ item: 'Brakes', ok: true }, { item: 'Tyres', ok: true }, { item: 'Tarpaulin cover', ok: false, note: '...' }] */
  @Column({ type: 'jsonb' }) items: Array<{ item: string; ok: boolean; note?: string }>;
  @Column({ type: 'boolean' }) passed: boolean;
  @Column({ type: 'boolean', default: false }) driverAcknowledged: boolean;
  @Column({ type: 'double precision', nullable: true }) odometerKm: number | null;
  @Column({ type: 'varchar', length: 160 }) completedBy: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/**
 * Trip timeline: incidents, delays, stops, dispatcher communication and status changes.
 * type: INCIDENT | DELAY | STOP | NOTE | STATUS_CHANGE | COMMUNICATION
 * severity (incidents): LOW | MEDIUM | HIGH | CRITICAL
 */
@Entity('trip_events')
@Index(['tripId', 'occurredAt'])
export class TripEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) tripId: string;
  @Column({ type: 'varchar', length: 16 }) type: string;
  @Column({ type: 'varchar', length: 10, nullable: true }) severity: string | null;
  @Column({ type: 'text' }) description: string;
  @Column({ type: 'double precision', nullable: true }) latitude: number | null;
  @Column({ type: 'double precision', nullable: true }) longitude: number | null;
  @Column({ type: 'jsonb', nullable: true }) data: Record<string, unknown> | null;
  @Column({ type: 'varchar', length: 160 }) recordedBy: string;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
}

/**
 * Delivery confirmation = handover evidence (§9.3). Several rows per shipment are allowed (partial deliveries).
 * condition: GOOD | DAMAGED | PARTIAL_DAMAGE | WET | SHORT
 * status: CONFIRMED | DISCREPANCY | REJECTED
 */
@Entity('deliveries')
@Index(['shipmentId'])
@Index('uq_delivery_idempotency', ['idempotencyKey'], { unique: true, where: 'idempotency_key IS NOT NULL' })
export class Delivery {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) shipmentId: string;
  @Column({ type: 'uuid' }) tripId: string;
  @Column({ type: 'timestamptz' }) deliveredAt: Date;
  @Column({ type: 'varchar', length: 160 }) receiverName: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) receiverPhone: string | null;
  @Column(QTY()) receivedQuantity: number;
  @Column({ type: 'varchar', length: 10, default: 'MT' }) quantityUnit: string;
  /** received − loaded (negative = shortage) */
  @Column(QTY({ default: 0 })) discrepancyQuantity: number;
  @Column({ type: 'varchar', length: 16, default: 'GOOD' }) condition: string;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  /** Private storage key of the proof-of-delivery file (signed note / photo) */
  @Column({ type: 'text', nullable: true }) proofOfDeliveryStorageKey: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) proofSha256: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) proofMimeType: string | null;
  @Column({ type: 'varchar', length: 160 }) confirmedBy: string;
  @Column({ type: 'varchar', length: 12, default: 'CONFIRMED' }) status: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) idempotencyKey: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/** Idempotency keys for dispatch and other non-repeatable commands (Idempotency-Key header). */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'varchar', length: 120 }) key: string;
  /** e.g. TRIP_DISPATCH */
  @Column({ type: 'varchar', length: 40 }) scope: string;
  @Column({ type: 'varchar', length: 60 }) referenceId: string;
  @Column({ type: 'jsonb', nullable: true }) response: unknown;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
