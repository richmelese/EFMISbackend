/** Alert source types whose source id is an administrative unit (the alert's scope unit). */
export const AREA_SOURCE_TYPES = ['KEBELE', 'WOREDA', 'ZONE', 'REGION'];

interface Runner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Sets alerts.unit_id from area-sourced alerts (used by the migration and the seeder). Idempotent. */
export async function backfillAlertUnits(q: Runner): Promise<void> {
  await q.query(
    `UPDATE alerts a SET unit_id = a.source_id
     WHERE a.unit_id IS NULL AND a.source_type = ANY($1) AND EXISTS (SELECT 1 FROM admin_units u WHERE u.id = a.source_id)`,
    [AREA_SOURCE_TYPES]
  );
}
