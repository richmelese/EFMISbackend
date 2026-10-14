import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { QTY } from '../../../../common/utils/decimal';

/**
 * QR scan of a shipment's bags/lot at a custody point — chain of custody from origin to destination.
 * scanType: DISPATCH_ORIGIN | CHECKPOINT | HANDOVER | RECEIVE_DESTINATION
 * result: MATCH (lot belongs to the shipment) | MISMATCH (raises a Theft/Diversion alert)
 */
@Entity('shipment_scan_events')
@Index(['shipmentId', 'scannedAt'])
export class ShipmentScanEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) shipmentId: string;
  @Column({ type: 'uuid', nullable: true }) tripId: string | null;
  @Column({ type: 'varchar', length: 24 }) scanType: string;
  /** Scanned QR code / lot number */
  @Column({ type: 'varchar', length: 64 }) lotNumber: string;
  @Column({ type: 'int', nullable: true }) bagCount: number | null;
  @Column({ type: 'varchar', length: 10 }) result: string;
  @Column({ type: 'varchar', length: 40 }) scannedBy: string;
  @Column({ type: 'varchar', length: 160 }) scannedByName: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) deviceSerial: string | null;
  @Column({ type: 'uuid', nullable: true }) warehouseId: string | null;
  @Column({ type: 'double precision', nullable: true }) latitude: number | null;
  @Column({ type: 'double precision', nullable: true }) longitude: number | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) locationLabel: string | null;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  /** Client-generated id so an offline scanner can resend safely (idempotency) */
  @Index({ unique: true, where: 'client_scan_id IS NOT NULL' }) @Column({ type: 'varchar', length: 80, nullable: true }) clientScanId: string | null;
  /** When the bag was scanned (device clock) */
  @Column({ type: 'timestamptz' }) scannedAt: Date;
  @CreateDateColumn({ type: 'timestamptz' }) receivedAt: Date;
}

/**
 * Security incident (theft, diversion, robbery, tampering, accident, unauthorised stop) with police reference and
 * a resolution record. status: OPEN | INVESTIGATING | RESOLVED | CLOSED
 */
@Entity('security_incidents')
@Index(['status', 'occurredAt'])
export class SecurityIncident {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** SI-1001 */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 20 }) incidentNumber: string;
  @Index() @Column({ type: 'uuid', nullable: true }) shipmentId: string | null;
  @Index() @Column({ type: 'uuid', nullable: true }) tripId: string | null;
  @Column({ type: 'uuid', nullable: true }) truckId: string | null;
  @Column({ type: 'varchar', length: 24 }) incidentType: string;
  @Column({ type: 'varchar', length: 10, default: 'HIGH' }) severity: string;
  @Column({ type: 'text' }) description: string;
  @Column({ type: 'timestamptz' }) occurredAt: Date;
  @Column({ type: 'double precision', nullable: true }) latitude: number | null;
  @Column({ type: 'double precision', nullable: true }) longitude: number | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) locationLabel: string | null;
  @Column(QTY({ nullable: true })) quantityAffectedMt: number | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) policeReportNo: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) policeStation: string | null;
  @Column({ type: 'varchar', length: 14, default: 'OPEN' }) status: string;
  @Column({ type: 'text', nullable: true }) resolution: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) resolvedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
  @Column({ type: 'varchar', length: 40 }) reportedBy: string;
  @Column({ type: 'varchar', length: 160 }) reportedByName: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) alertId: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
