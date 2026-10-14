import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import { FarmerDemand } from './farmer-demand.entity';

/**
 * Farmer registry record (REQ-1.1-001). One record per farmer per season.
 * approvalLevel values: 'Pending Kebele Review' | 'Kebele Approved • Forwarded to Woreda' | 'Returned for Revision' |
 * 'Rejected by Kebele' | 'Partially Approved • Revision Requested' | 'Woreda Approved' | 'Zone Approved' | 'Region Approved'
 */
@Entity('farmers')
@Index(['kebeleId'])
@Index(['regionId'])
export class Farmer {
  /** FARM-YYYY-XXXXX */
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id: string;

  @Column({ type: 'varchar', length: 80, nullable: true }) firstName: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) middleName: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) lastName: string | null;
  @Column({ type: 'varchar', length: 240 }) name: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) motherName: string | null;

  @Index('uq_farmers_fayda_active', { unique: true, where: 'fayda_id IS NOT NULL AND deleted = false' })
  @Column({ type: 'varchar', length: 40, nullable: true })
  faydaId: string | null;

  /** VERIFIED_ACTIVE | FAYDA_VERIFICATION_PENDING */
  @Column({ type: 'varchar', length: 40, default: 'FAYDA_VERIFICATION_PENDING' })
  faydaStatus: string;

  @Column({ type: 'varchar', length: 40, nullable: true }) nationalIdNumber: string | null;
  @Column({ type: 'varchar', length: 20 }) phone: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) phoneSecondary: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) gender: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) ageGroup: string | null;
  @Column({ type: 'int', nullable: true }) householdSize: number | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) educationLevel: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) primaryOccupation: string | null;

  @Column({ type: 'varchar', length: 40 }) regionId: string;
  @Column({ type: 'varchar', length: 40 }) zoneId: string;
  @Column({ type: 'varchar', length: 40 }) woredaId: string;
  @Column({ type: 'varchar', length: 40 }) kebeleId: string;
  /** Denormalised display names (frontend shape) */
  @Column({ type: 'varchar', length: 160 }) region: string;
  @Column({ type: 'varchar', length: 160 }) zone: string;
  @Column({ type: 'varchar', length: 160 }) woreda: string;
  @Column({ type: 'varchar', length: 160 }) kebele: string;

  @Column({ type: 'varchar', length: 240, nullable: true }) cooperative: string | null;

  @Index('uq_farmers_land_cert_active', { unique: true, where: 'deleted = false' })
  @Column({ type: 'varchar', length: 60 })
  landCertNumber: string;

  @Column({ type: 'boolean', default: false }) landCertVerified: boolean;
  @Column({ type: 'double precision' }) farmSizeHa: number;
  @Column({ type: 'varchar', length: 120, nullable: true }) irrigationAccess: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) landTenure: string | null;
  @Column({ type: 'jsonb', default: () => `'[]'` }) crops: string[];
  @Column({ type: 'varchar', length: 120, nullable: true }) targetCrop: string | null;
  @Column({ type: 'varchar', length: 40 }) season: string;
  @Column({ type: 'varchar', length: 10, nullable: true }) submissionDate: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true }) daUserId: string | null;
  @Column({ type: 'varchar', length: 160, nullable: true }) daName: string | null;
  @Column({ type: 'int', nullable: true }) creditScore: number | null;
  @Column({ type: 'double precision', default: 0 }) creditArrearsEtb: number;
  @Column({ type: 'varchar', length: 20, nullable: true }) telebirrPhone: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) cbeAccount: string | null;
  @Column({ type: 'varchar', length: 240, nullable: true }) photoUrl: string | null;

  @Column({ type: 'varchar', length: 60, default: 'Pending Kebele Review' })
  approvalLevel: string;

  @Column({ type: 'text', nullable: true }) notes: string | null;
  @Column({ type: 'double precision', nullable: true }) gpsLat: number | null;
  @Column({ type: 'double precision', nullable: true }) gpsLng: number | null;
  @Column({ type: 'boolean', default: false }) consentGiven: boolean;

  /** ONLINE | OFFLINE_SYNC */
  @Column({ type: 'varchar', length: 20, default: 'ONLINE' }) source: string;

  @Index('uq_farmers_client_uuid', { unique: true, where: 'client_uuid IS NOT NULL' })
  @Column({ type: 'varchar', length: 80, nullable: true })
  clientUuid: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true }) deviceId: string | null;

  @VersionColumn() version: number;
  @Column({ type: 'boolean', default: false }) deleted: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;

  @OneToMany(() => FarmerDemand, d => d.farmer, { cascade: true })
  demands: FarmerDemand[];
}
