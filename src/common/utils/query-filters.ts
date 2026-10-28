import { SelectQueryBuilder } from 'typeorm';

/** Escape ILIKE wildcards so user input can't inject unintended % / _ matches. */
export const escapeLike = (s: string): string => s.replace(/[%_\\]/g, m => '\\' + m);

/**
 * Case-insensitive OR search across columns/expressions, e.g.
 * `applySearch(qb, ['f.name', 'f.id', "(f.first || ' ' || f.last)"], q.q)`.
 * No-op when `q` is empty. The shared replacement for the ad hoc
 * `qb.andWhere('(a ILIKE :q OR b ILIKE :q)', ...)` repeated per module.
 */
export function applySearch<T extends object>(qb: SelectQueryBuilder<T>, columns: string[], q?: string, param = 'q'): SelectQueryBuilder<T> {
  if (!q || !columns.length) return qb;
  const clause = columns.map(c => `${c} ILIKE :${param}`).join(' OR ');
  return qb.andWhere(`(${clause})`, { [param]: `%${escapeLike(q)}%` });
}

/** Inclusive date/timestamp range filter on a single column; either bound may be omitted. */
export function applyDateRange<T extends object>(
  qb: SelectQueryBuilder<T>, column: string, from?: string | Date, to?: string | Date
): SelectQueryBuilder<T> {
  if (from) qb.andWhere(`${column} >= :${column.replace('.', '_')}From`, { [`${column.replace('.', '_')}From`]: from });
  if (to) qb.andWhere(`${column} <= :${column.replace('.', '_')}To`, { [`${column.replace('.', '_')}To`]: to });
  return qb;
}

/** Sort by an allow-listed field (via sortMap) instead of a raw column, to avoid SQL injection through `sort`. */
export function applySort<T extends object>(
  qb: SelectQueryBuilder<T>, sortMap: Record<string, string>, sort?: string, order?: string, fallback?: string
): SelectQueryBuilder<T> {
  const field = (sort && sortMap[sort]) || fallback || Object.values(sortMap)[0];
  if (field) qb.orderBy(field, order === 'desc' ? 'DESC' : 'ASC');
  return qb;
}
