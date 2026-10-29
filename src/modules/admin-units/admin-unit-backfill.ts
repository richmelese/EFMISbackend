/**
 * Builds `admin_units` from the legacy regions/zones/woredas/kebeles tables (same IDs) and assigns every user their
 * scope unit. Used by the B2 migration and by the seeder (which fills the legacy tables first). Idempotent.
 */
export const COUNTRY_UNIT_ID = 'ET';

interface Runner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** ltree label for an id (ltree labels allow [A-Za-z0-9_] only). SQL twin: LABEL() below. */
export const ltreeLabel = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, '_');

const LABEL = (col: string) => `text2ltree(regexp_replace(${col}, '[^A-Za-z0-9_]', '_', 'g'))`;

export async function backfillAdminUnits(q: Runner): Promise<void> {
  await q.query(
    `INSERT INTO admin_units (id, type, code, name, parent_id, path, sort) VALUES ($1::varchar, 'COUNTRY', $1::varchar, 'Ethiopia', NULL, text2ltree($1::text), 0)
     ON CONFLICT (id) DO NOTHING`,
    [COUNTRY_UNIT_ID]
  );
  const levels: Array<[type: string, table: string, parentCol: string | null, codeCol: string]> = [
    ['REGION', 'regions', null, 'code'],
    ['ZONE', 'zones', 'region_id', 'id'],
    ['WOREDA', 'woredas', 'zone_id', 'id'],
    ['KEBELE', 'kebeles', 'woreda_id', 'id']
  ];
  for (const [type, table, parentCol, codeCol] of levels) {
    const parent = parentCol ? `t.${parentCol}` : `'${COUNTRY_UNIT_ID}'`;
    await q.query(
      `INSERT INTO admin_units (id, type, code, name, parent_id, path, sort)
       SELECT t.id, '${type}', t.${codeCol}, t.name, p.id, p.path || ${LABEL('t.id')}, t.sort
       FROM ${table} t JOIN admin_units p ON p.id = ${parent}
       ON CONFLICT (id) DO NOTHING`
    );
  }
}

/** users.admin_unit_id: the unit their base role is scoped to (same rule as scopeUnitId() in common/utils/scope). */
export async function backfillUserUnits(q: Runner): Promise<void> {
  await q.query(`
    UPDATE users u SET admin_unit_id = CASE
        WHEN b.base IN ('DA', 'KEBELE') AND u.kebele_id IS NOT NULL THEN u.kebele_id
        WHEN b.base = 'WOREDA' AND u.woreda_id IS NOT NULL THEN u.woreda_id
        WHEN b.base = 'ZONE' AND u.zone_id IS NOT NULL THEN u.zone_id
        ELSE u.region_id END
    FROM (SELECT id, COALESCE(base_role, id) AS base FROM roles) b
    WHERE b.id = u.role`);
}
