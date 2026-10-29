/**
 * Season names as the system has always written them ("Meher 2026", "Belg 2026", "Irrigation 2026-27") mapped to
 * season rows. Shared by the B1 migration (backfill from settings) and the seeder so both create identical rows.
 */
export const SEASON_TYPES = ['MEHER', 'BELG', 'IRRIGATION'] as const;
export type SeasonType = (typeof SEASON_TYPES)[number];

export const SEASON_STATUSES = ['PLANNING', 'OPEN', 'CLOSED'] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export interface SeasonSeed {
  id: string;
  name: string;
  type: SeasonType;
  year: number;
  startsOn: string;
  endsOn: string;
  collectionDeadline: string;
}

/**
 * Default calendar per season type (month/day, year offset from the season's start year). Meher is the main rainy
 * season, Belg the short rains, Irrigation the dry season across two calendar years. Demand collection closes before
 * the season starts. Administrators adjust real dates in Phase 1.
 */
const CALENDAR: Record<SeasonType, { starts: string; ends: [number, string]; deadline: [number, string] }> = {
  MEHER: { starts: '06-01', ends: [0, '12-31'], deadline: [0, '03-31'] },
  BELG: { starts: '02-01', ends: [0, '05-31'], deadline: [-1, '11-30'] },
  IRRIGATION: { starts: '11-01', ends: [1, '04-30'], deadline: [0, '08-31'] }
};

/** "Meher 2026" → MEHER-2026 with default dates; null when the name is not "<type> <year>[-yy]". */
export function seasonFromName(name: string): SeasonSeed | null {
  const m = /^\s*(meher|belg|irrigation)\s+(\d{4})(?:\s*[-/]\s*\d{2,4})?\s*$/i.exec(name || '');
  if (!m) return null;
  const type = m[1].toUpperCase() as SeasonType;
  const year = Number(m[2]);
  const c = CALENDAR[type];
  return {
    id: `${type}-${year}`,
    name: name.trim(),
    type,
    year,
    startsOn: `${year}-${c.starts}`,
    endsOn: `${year + c.ends[0]}-${c.ends[1]}`,
    collectionDeadline: `${year + c.deadline[0]}-${c.deadline[1]}`
  };
}

/** Status for a season known from settings: the current one is OPEN, later ones PLANNING, earlier ones CLOSED. */
export function seasonStatusRelativeTo(s: SeasonSeed, current: SeasonSeed | null): SeasonStatus {
  if (!current || s.id === current.id) return 'OPEN';
  return s.startsOn > current.startsOn ? 'PLANNING' : 'CLOSED';
}
