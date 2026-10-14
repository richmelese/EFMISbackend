import { NATIONAL_ROLES } from '../constants/permissions';
import { AuthUser } from '../types/auth-user';
import { Errors } from './errors';

export interface UnitRef {
  regionId?: string | null;
  zoneId?: string | null;
  woredaId?: string | null;
  kebeleId?: string | null;
}

export const isNational = (user: AuthUser): boolean => NATIONAL_ROLES.includes(user.role);

/**
 * TypeORM where-fragment restricting rows to the user's administrative area (data segmentation, REQ-1.7-001).
 * Entity `alias` must have regionId / zoneId / woredaId / kebeleId properties.
 * Usage: qb.andWhere(s.sql, s.params)
 */
export function scopeCondition(user: AuthUser, alias: string): { sql: string; params: Record<string, unknown> } {
  if (isNational(user)) return { sql: '1=1', params: {} };
  if (user.kebeleId && ['DA', 'KEBELE'].includes(user.role)) return { sql: `${alias}.kebeleId = :scopeId`, params: { scopeId: user.kebeleId } };
  if (user.woredaId && user.role === 'WOREDA') return { sql: `${alias}.woredaId = :scopeId`, params: { scopeId: user.woredaId } };
  if (user.zoneId && user.role === 'ZONE') return { sql: `${alias}.zoneId = :scopeId`, params: { scopeId: user.zoneId } };
  if (user.regionId) return { sql: `${alias}.regionId = :scopeId`, params: { scopeId: user.regionId } };
  return { sql: '1=0', params: {} };
}

export function inScope(user: AuthUser, unit: UnitRef): boolean {
  if (isNational(user)) return true;
  if (['DA', 'KEBELE'].includes(user.role)) return !!unit.kebeleId && unit.kebeleId === user.kebeleId;
  if (user.role === 'WOREDA') return !!unit.woredaId && unit.woredaId === user.woredaId;
  if (user.role === 'ZONE') return !!unit.zoneId && unit.zoneId === user.zoneId;
  if (user.regionId) return unit.regionId === user.regionId;
  return false;
}

export function assertInScope(user: AuthUser, unit: UnitRef, what = 'record'): void {
  if (!inScope(user, unit)) throw Errors.forbidden(`This ${what} is outside your assigned administrative area`);
}
