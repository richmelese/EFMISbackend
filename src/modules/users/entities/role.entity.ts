import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Role (REQ-1.7-001). System roles are built in (code `Role` enum); administrators can add custom roles. A custom role
 * is based on a system role (`baseRole`), which decides its data scope, while its own permission set decides what it
 * may do.
 */
@Entity('roles')
export class RoleEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 40 })
  level: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** System role whose data scope applies (equals id for system roles) */
  @Column({ type: 'varchar', length: 40, nullable: true })
  baseRole: string | null;

  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/** Catalogue of permission keys checked by the code (synced at startup). */
@Entity('permissions')
export class PermissionEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  key: string;

  @Column({ type: 'varchar', length: 60 })
  group: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'boolean', default: false })
  sensitive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** Grant of one permission to one role. */
@Entity('role_permissions')
@Index(['permissionKey'])
export class RolePermission {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  roleId: string;

  @PrimaryColumn({ type: 'varchar', length: 60 })
  permissionKey: string;

  @ManyToOne(() => RoleEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: RoleEntity;

  @ManyToOne(() => PermissionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_key' })
  permission?: PermissionEntity;

  @Column({ type: 'varchar', length: 40, nullable: true })
  grantedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt: Date;
}
