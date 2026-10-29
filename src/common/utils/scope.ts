import { NATIONAL_ROLES } from '../constants/permissions';
import { AdministrativeScope, AuthUser } from '../types/auth-user';
import { Errors } from './errors';

/**
 * Where a record sits in the unit tree. Records carry the legacy chain columns (regionId … kebeleId); `path` is the
 * record unit's admin_units.path when the caller already has it.
 */
export interface UnitRef {
  regionId?: string | null;
  zoneId?: string | null;
  woredaId?: string | null;
  kebeleId?: string | null;
  path?: string | null;
}

/**
 * Data segmentation (REQ-1.7-001) is one rule: a record is in scope when its unit is inside the user's unit
 * (`admin_units.path <@ userUnit.path`). National roles see everything. Every module scopes through these helpers.
 */
export const isNational = (user: Pick<AuthUser, 'role'>): boolean => NATIONAL_ROLES.includes(user.role);

/** The unit a base role's data scope is anchored at (stored as users.admin_unit_id). */
export function scopeUnitId(baseRole: string, s: Partial<AdministrativeScope>): string | null {
  if (['DA', 'KEBELE'].includes(baseRole) && s.kebeleId) return s.kebeleId;
  if (baseRole === 'WOREDA' && s.woredaId) return s.woredaId;
  if (baseRole === 'ZONE' && s.zoneId) return s.zoneId;
  return s.regionId ?? null;
}

const ownUnit = (user: AuthUser): string | null => (user.adminUnitId !== undefined ? user.adminUnitId : scopeUnitId(user.role, user));

/** ltree `inner <@ outer` on path strings. */
export const pathWithin = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}.`);

/**
 * TypeORM where-fragment restricting rows to the user's unit subtree. The record's unit is `alias.unitColumn`, or by
 * default the most specific of alias.kebeleId / woredaId / zoneId / regionId.
 * Usage: const s = scopeCondition(user, 'f'); qb.andWhere(s.sql, s.params)
 */
export function scopeCondition(user: AuthUser, alias: string, unitColumn?: string): { sql: string; params: Record<string, unknown> } {
  if (isNational(user)) return { sql: '1=1', params: {} };
  const unitId = ownUnit(user);
  if (!unitId) return { sql: '1=0', params: {} };
  const recordUnit = unitColumn ? `${alias}.${unitColumn}` : `COALESCE(${alias}.kebeleId, ${alias}.woredaId, ${alias}.zoneId, ${alias}.regionId)`;
  return {
    sql: `${recordUnit} IN (SELECT su.id FROM admin_units su WHERE su.path <@ (SELECT sp.path FROM admin_units sp WHERE sp.id = :scopeUnitId))`,
    params: { scopeUnitId: unitId }
  };
}

/** Record unit inside the user's unit. */
export function inScope(user: AuthUser, unit: UnitRef): boolean {
  if (isNational(user)) return true;
  const own = ownUnit(user);
  if (!own) return false;
  if (unit.path && user.unitPath) return pathWithin(unit.path, user.unitPath);
  // Without paths: the user's unit must be on the record's ancestor chain (same rule for the four legacy levels).
  return [unit.regionId, unit.zoneId, unit.woredaId, unit.kebeleId].includes(own);
}

/** The user's own unit is inside `unit` (roll-up views of the areas above the user). */
export function containsUserUnit(user: AuthUser, unit: UnitRef): boolean {
  if (isNational(user)) return true;
  const own = ownUnit(user);
  if (!own) return false;
  if (unit.path && user.unitPath) return pathWithin(user.unitPath, unit.path);
  // Without paths: `unit` must be on the user's own chain, at or above the user's unit.
  const chain = [user.regionId, user.zoneId, user.woredaId, user.kebeleId];
  const deepest = unit.kebeleId || unit.woredaId || unit.zoneId || unit.regionId;
  const at = deepest ? chain.indexOf(deepest) : -1;
  return at >= 0 && at <= chain.indexOf(own);
}

/** Inside the user's unit, or above it (roll-up and breadcrumb views of the areas a user belongs to). */
export const unitVisible = (user: AuthUser, unit: UnitRef): boolean => inScope(user, unit) || containsUserUnit(user, unit);

/** 403 OUT_OF_SCOPE unless the record's unit is inside the user's unit. */
export function assertInScope(user: AuthUser, unit: UnitRef | null, what = 'record'): void {
  if (!unit || !inScope(user, unit)) throw Errors.outOfScope(what);
}

/** 403 OUT_OF_SCOPE unless the unit is inside or above the user's unit (read-only roll-up views). */
export function assertUnitVisible(user: AuthUser, unit: UnitRef | null, what = 'unit'): void {
  if (!unit || !unitVisible(user, unit)) throw Errors.outOfScope(what);
}
