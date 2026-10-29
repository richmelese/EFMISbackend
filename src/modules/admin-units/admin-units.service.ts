import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { assertInScope, assertUnitVisible, isNational, UnitRef } from '../../common/utils/scope';
import { AdminUnit } from './entities/admin-unit.entity';
import { AdminUnitDetailDto, AdminUnitDto, AdminUnitTreeDto } from './dto/admin-unit.dto';
import { COUNTRY_UNIT_ID } from './admin-unit-backfill';

/** Legacy chain column for each of the four original levels. */
const CHAIN_KEY: Partial<Record<AdminUnit['type'], keyof UnitRef>> = { REGION: 'regionId', ZONE: 'zoneId', WOREDA: 'woredaId', KEBELE: 'kebeleId' };

/** The administrative unit tree. Owner of `admin_units`. */
@Injectable()
export class AdminUnitsService {
  /** id → path; units change rarely (Phase 1 editing calls invalidate()). */
  private readonly paths = new Map<string, string | null>();

  constructor(@InjectRepository(AdminUnit) readonly repo: Repository<AdminUnit>) {}

  private r(m?: EntityManager) {
    return m ? m.getRepository(AdminUnit) : this.repo;
  }

  invalidate(): void {
    this.paths.clear();
  }

  async pathOf(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    if (!this.paths.has(id)) this.paths.set(id, (await this.repo.findOne({ where: { id }, select: { id: true, path: true } }))?.path ?? null);
    return this.paths.get(id)!;
  }

  findById(id: string, m?: EntityManager): Promise<AdminUnit | null> {
    return this.r(m).findOne({ where: { id } });
  }

  async byId(id: string, m?: EntityManager): Promise<AdminUnit> {
    const u = await this.findById(id, m);
    if (!u) throw Errors.notFound(`Administrative unit ${id} not found`);
    return u;
  }

  /** Ancestors from the country down to the parent. */
  async ancestors(unit: AdminUnit, m?: EntityManager): Promise<AdminUnit[]> {
    return this.r(m)
      .createQueryBuilder('a')
      .where('a.path @> CAST(:path AS ltree) AND a.id <> :id', { path: unit.path, id: unit.id })
      .orderBy('nlevel(a.path)', 'ASC')
      .getMany();
  }

  children(parentId: string, m?: EntityManager): Promise<AdminUnit[]> {
    return this.r(m).find({ where: { parentId }, order: { sort: 'ASC', name: 'ASC' } });
  }

  /** The unit and everything below it, ordered so parents come before children. */
  subtree(unit: AdminUnit, m?: EntityManager): Promise<AdminUnit[]> {
    return this.r(m)
      .createQueryBuilder('a')
      .where('a.path <@ CAST(:path AS ltree)', { path: unit.path })
      .orderBy('nlevel(a.path)', 'ASC')
      .addOrderBy('a.sort', 'ASC')
      .addOrderBy('a.name', 'ASC')
      .getMany();
  }

  /** Scope reference of a unit: its path plus the legacy region/zone/woreda/kebele chain. */
  async unitRef(idOrUnit: string | AdminUnit, m?: EntityManager): Promise<UnitRef | null> {
    const unit = typeof idOrUnit === 'string' ? await this.findById(idOrUnit, m) : idOrUnit;
    if (!unit) return null;
    const ref: UnitRef = { path: unit.path };
    for (const u of [...(await this.ancestors(unit, m)), unit]) {
      const key = CHAIN_KEY[u.type];
      if (key) (ref as Record<string, unknown>)[key] = u.id;
    }
    return ref;
  }

  /** The unit the user's tree starts at: the country for national roles, otherwise their own unit (or none). */
  async rootFor(user: AuthUser): Promise<AdminUnit | null> {
    if (isNational(user)) return this.findById(COUNTRY_UNIT_ID);
    return user.adminUnitId ? this.findById(user.adminUnitId) : null;
  }

  async tree(user: AuthUser): Promise<AdminUnitTreeDto[]> {
    const root = await this.rootFor(user);
    if (!root) return [];
    const nodes = new Map<string, AdminUnitTreeDto>();
    const roots: AdminUnitTreeDto[] = [];
    for (const u of await this.subtree(root)) {
      const node: AdminUnitTreeDto = { ...this.toDto(u), children: [] };
      nodes.set(u.id, node);
      const parent = u.id === root.id ? undefined : nodes.get(u.parentId!);
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  /** A unit is readable when it is inside the user's unit, or above it (breadcrumbs, roll-up views). */
  async detail(user: AuthUser, id: string): Promise<AdminUnitDetailDto> {
    const unit = await this.byId(id);
    const ref = (await this.unitRef(unit))!;
    assertUnitVisible(user, ref);
    const childCount = await this.repo.count({ where: { parentId: id } });
    return { ...this.toDto(unit), ancestors: (await this.ancestors(unit)).map(a => this.toDto(a)), childCount };
  }

  /** Children only inside the user's unit (a unit above it would expose sibling areas). */
  async childrenFor(user: AuthUser, id: string): Promise<AdminUnitDto[]> {
    const ref = await this.unitRef(id);
    if (!ref) throw Errors.notFound(`Administrative unit ${id} not found`);
    assertInScope(user, ref, 'unit');
    return (await this.children(id)).map(u => this.toDto(u));
  }

  async byIds(ids: string[], m?: EntityManager): Promise<AdminUnit[]> {
    return ids.length ? this.r(m).find({ where: { id: In(ids) } }) : [];
  }

  toDto(u: AdminUnit): AdminUnitDto {
    return { id: u.id, type: u.type, code: u.code, name: u.name, nameAm: u.nameAm, nameOm: u.nameOm, parentId: u.parentId, path: u.path, active: u.active };
  }
}
