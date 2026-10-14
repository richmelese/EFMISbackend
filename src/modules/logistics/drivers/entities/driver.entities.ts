import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Driver (Logistics doc §6.1). Account/employment status is kept separate from availability and from trip status.
 * verificationStatus: PENDING_VERIFICATION | VERIFIED | REJECTED
 * employmentStatus:   ACTIVE | INACTIVE | SUSPENDED | ON_LEAVE
 * availabilityStatus: AVAILABLE | ASSIGNED | ON_TRIP | UNAVAILABLE | DOCUMENT_EXPIRED
 */
@Entity('drivers')
export class Driver {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40 }) employeeNumber: string;
  @Column({ type: 'varchar', length: 80 }) firstName: string;
  @Column({ type: 'varchar', length: 80 }) lastName: string;
  @Column({ type: 'varchar', length: 20 }) phone: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) email: string | null;
  /** Restricted: only returned with drivers:sensitive */
  @Index({ unique: true }) @Column({ type: 'varchar', length: 40 }) licenceNumber: string;
  /** e.g. B, C1, C, CE (heavy goods) */
  @Column({ type: 'varchar', length: 10 }) licenceClass: string;
  @Column({ type: 'date' }) licenceExpiryDate: string;
  @Column({ type: 'varchar', length: 24, default: 'PENDING_VERIFICATION' }) verificationStatus: string;
  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' }) employmentStatus: string;
  @Column({ type: 'varchar', length: 20, default: 'UNAVAILABLE' }) availabilityStatus: string;
  @Column({ type: 'jsonb', default: () => `'[]'` }) certifications: Array<{ name: string; expiresAt?: string | null }>;
  @Column({ type: 'varchar', length: 160, nullable: true }) emergencyContactName: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) emergencyContactPhone: string | null;
  /** Organisation the driver works for (e.g. ESLSE, transporter company) */
  @Column({ type: 'varchar', length: 120, nullable: true }) employer: string | null;
  /** Optional login account (DRIVER role) */
  @Index({ unique: true, where: 'user_id IS NOT NULL' }) @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'text', nullable: true }) suspensionReason: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}

/**
 * Securely stored driver document (licence scan, ID, certificate, medical).
 * verificationStatus: PENDING | VERIFIED | REJECTED | EXPIRED
 */
@Entity('driver_documents')
@Index(['driverId'])
export class DriverDocument {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) driverId: string;
  /** LICENCE | NATIONAL_ID | CERTIFICATE | MEDICAL | OTHER */
  @Column({ type: 'varchar', length: 20 }) documentType: string;
  /** Path/key in private storage — never exposed directly */
  @Column({ type: 'text' }) secureStorageKey: string;
  @Column({ type: 'varchar', length: 200 }) fileName: string;
  @Column({ type: 'varchar', length: 60 }) mimeType: string;
  @Column({ type: 'int' }) sizeBytes: number;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 64 }) sha256: string;
  @Column({ type: 'date', nullable: true }) issuedAt: string | null;
  @Column({ type: 'date', nullable: true }) expiresAt: string | null;
  @Column({ type: 'varchar', length: 12, default: 'PENDING' }) verificationStatus: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) verifiedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) verifiedAt: Date | null;
  @Column({ type: 'text', nullable: true }) rejectionReason: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) uploadedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/** Shift / leave / unavailability windows. availabilityType: SHIFT | LEAVE | UNAVAILABLE | TRAINING */
@Entity('driver_availability')
@Index(['driverId', 'startAt'])
export class DriverAvailability {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) driverId: string;
  @Column({ type: 'timestamptz' }) startAt: Date;
  @Column({ type: 'timestamptz' }) endAt: Date;
  @Column({ type: 'varchar', length: 16 }) availabilityType: string;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/**
 * Driver ↔ trip assignment. status: ACTIVE | RELEASED | REASSIGNED.
 * A partial unique index allows at most ONE ACTIVE assignment per driver (double-booking prevention at DB level).
 */
@Entity('driver_trip_assignments')
@Index('uq_driver_active_assignment', ['driverId'], { unique: true, where: `status = 'ACTIVE'` })
@Index(['tripId'])
export class DriverTripAssignment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) driverId: string;
  @Column({ type: 'uuid' }) tripId: string;
  /** PRIMARY | RELIEF */
  @Column({ type: 'varchar', length: 10, default: 'PRIMARY' }) role: string;
  @Column({ type: 'timestamptz' }) assignedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) releasedAt: Date | null;
  @Column({ type: 'varchar', length: 160 }) assignedBy: string;
  @Column({ type: 'varchar', length: 12, default: 'ACTIVE' }) status: string;
}
