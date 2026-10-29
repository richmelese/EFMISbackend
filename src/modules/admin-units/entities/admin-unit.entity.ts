import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const ADMIN_UNIT_TYPES = ['COUNTRY', 'REGION', 'ZONE', 'WOREDA', 'KEBELE', 'UNION', 'PC', 'CITY_ADMIN', 'SPECIAL_WOREDA'] as const;
export type AdminUnitType = (typeof ADMIN_UNIT_TYPES)[number];

/**
 * One administrative or cooperative unit (country, region, zone, woreda, kebele, union, PC, city administration,
 * special woreda). `path` is the ltree of ancestor labels, so "inside unit X" is `path <@ X.path` (data scope).
 * Region/zone/woreda/kebele rows keep the IDs of the legacy tables, so existing *_id columns stay valid.
 */
@Entity('admin_units')
@Check('CHK_admin_units_root', `(type = 'COUNTRY') = (parent_id IS NULL)`)
export class AdminUnit {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 20 })
  type: AdminUnitType;

  @Column({ type: 'varchar', length: 40, nullable: true })
  code: string | null;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  nameAm: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  nameOm: string | null;

  @Index('IDX_admin_units_parent_id')
  @Column({ type: 'varchar', length: 40, nullable: true })
  parentId: string | null;

  @ManyToOne(() => AdminUnit, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'parent_id' })
  parent?: AdminUnit;

  /** ltree, e.g. ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_ADAMA (labels: the id with non [A-Za-z0-9_] replaced by _) */
  @Column({ type: 'ltree', unique: true })
  path: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
