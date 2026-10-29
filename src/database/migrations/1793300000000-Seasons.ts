import { MigrationInterface, QueryRunner } from 'typeorm';
import { seasonFromName, seasonStatusRelativeTo } from '../../modules/seasons/season-calendar';

/**
 * Stage B1: `seasons` table. Backfilled from settings.systemMetadata (currentSeason + seasons list), so the season
 * that SettingsService.currentSeason() returned before keeps being the current one.
 */
export class Seasons1793300000000 implements MigrationInterface {
  name = 'Seasons1793300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "seasons" (
        "id" character varying(40) NOT NULL,
        "name" character varying(60) NOT NULL,
        "type" character varying(20) NOT NULL,
        "year" integer NOT NULL,
        "starts_on" date NOT NULL,
        "ends_on" date NOT NULL,
        "collection_deadline" date NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'PLANNING',
        "is_current" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_seasons" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_seasons_name" UNIQUE ("name"),
        CONSTRAINT "CHK_seasons_type" CHECK (type IN ('MEHER', 'BELG', 'IRRIGATION')),
        CONSTRAINT "CHK_seasons_status" CHECK (status IN ('PLANNING', 'OPEN', 'CLOSED')),
        CONSTRAINT "CHK_seasons_dates" CHECK (ends_on >= starts_on)
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_seasons_type_year" ON "seasons" ("type", "year")`);
    await q.query(`CREATE UNIQUE INDEX "UQ_seasons_current" ON "seasons" ("is_current") WHERE is_current`);

    const [row] = await q.query(`SELECT value FROM settings WHERE key = 'systemMetadata'`);
    const meta = row?.value ?? {};
    const current = seasonFromName(meta.currentSeason);
    const names: string[] = [...new Set([meta.currentSeason, ...(Array.isArray(meta.seasons) ? meta.seasons : [])].filter(Boolean))];
    for (const name of names) {
      const s = seasonFromName(name);
      if (!s) continue;
      await q.query(
        `INSERT INTO seasons (id, name, type, year, starts_on, ends_on, collection_deadline, status, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [s.id, s.name, s.type, s.year, s.startsOn, s.endsOn, s.collectionDeadline, seasonStatusRelativeTo(s, current), s.id === current?.id]
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "seasons"`);
  }
}
