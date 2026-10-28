/** Standard list response envelope: { items, total, page, pageSize }. */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Normalise page/pageSize query params (accepts numbers or numeric strings) into safe,
 * bounded values plus the skip/take a TypeORM query needs. The single source of truth for
 * every paginated list endpoint — do not re-derive page/pageSize/skip/take per module.
 */
export function pageParams(q: { page?: unknown; pageSize?: unknown }, maxPageSize = 200) {
  const page = Math.max(parseInt(String(q.page ?? '1'), 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(String(q.pageSize ?? '50'), 10) || 50, 1), maxPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
