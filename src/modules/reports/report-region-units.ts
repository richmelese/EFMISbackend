/**
 * Daily-report regions use their own ids; this maps them onto the admin unit tree (data scope). "South West Ethiopia"
 * has no unit yet (REG-OTHER covers Afar, Benishangul, Gambella and Harari) and stays national-only until Phase 1
 * loads the full unit list.
 */
export const REPORT_REGION_UNITS: Record<string, string> = {
  oromia: 'REG-OROMIA',
  amhara: 'REG-AMHARA',
  sidama: 'REG-SIDAMA',
  tigray: 'REG-TIGRAY',
  somali: 'REG-SOMALI',
  southEthiopia: 'REG-SOUTH',
  centralEthiopia: 'REG-SOUTH',
  benishangul: 'REG-OTHER',
  afar: 'REG-OTHER',
  gambella: 'REG-OTHER',
  harari: 'REG-OTHER'
};

interface Runner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Sets report_regions.admin_unit_id (migration and seeder). Idempotent. */
export async function backfillReportRegionUnits(q: Runner): Promise<void> {
  for (const [id, unit] of Object.entries(REPORT_REGION_UNITS)) {
    await q.query(
      `UPDATE report_regions SET admin_unit_id = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM admin_units WHERE id = $2)`,
      [id, unit]
    );
  }
}
