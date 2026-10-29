import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { RoleEntity } from './role.entity';

/** System user (REQ-1.7-001). Administrative scope columns drive data segmentation. */
@Entity('users')
export class User {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 160 })
  fullName: string;

  @Index({ unique: true, where: 'email IS NOT NULL' })
  @Column({ type: 'varchar', length: 160, nullable: true })
  email: string | null;

  @Index({ unique: true, where: 'phone IS NOT NULL' })
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Index({ unique: true, where: 'fayda_id IS NOT NULL' })
  @Column({ type: 'varchar', length: 40, nullable: true })
  faydaId: string | null;

  @Column({ type: 'varchar', length: 120, select: false })
  passwordHash: string;

  @Column({ type: 'varchar', length: 120, nullable: true, select: false })
  pinHash: string | null;

  /** Assigned role (system or custom) */
  @Column({ type: 'varchar', length: 40 })
  role: string;

  @ManyToOne(() => RoleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role' })
  roleRef?: RoleEntity;

  @Column({ type: 'varchar', length: 200, nullable: true })
  title: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  regionId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  zoneId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  woredaId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  kebeleId: string | null;

  /** Unit the data scope is anchored at (admin_units.id), derived from the base role and the columns above */
  @Index('IDX_users_admin_unit_id')
  @Column({ type: 'varchar', length: 40, nullable: true })
  adminUnitId: string | null;

  /** WAREHOUSE_OPERATOR scope (logistics warehouse UUID) */
  @Column({ type: 'uuid', nullable: true })
  warehouseId: string | null;

  @Column({ type: 'varchar', length: 4, default: 'en' })
  preferredLanguage: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  /** Tokens issued before this instant are rejected (deactivation, password reset, "sign out everywhere") */
  @Column({ type: 'timestamptz', nullable: true })
  tokensValidAfter: Date | null;

  /** Set when an administrator issues a temporary password; cleared when the user changes it */
  @Column({ type: 'boolean', default: false })
  mustChangePassword: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  createdBy: string | null;

  @Column({ type: 'text', nullable: true })
  deactivationReason: string | null;
}
