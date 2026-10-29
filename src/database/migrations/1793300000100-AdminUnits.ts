import { MigrationInterface, QueryRunner } from 'typeorm';
import { backfillAdminUnits, backfillUserUnits } from '../../modules/admin-units/admin-unit-backfill';

/**
 * Stage B2: `admin_units` (ltree) replaces the four fixed hierarchy tables as the unit tree. Backfilled from
 * regions/zones/woredas/kebeles keeping their IDs; the legacy tables stay (read-only for structure) because they
 * still hold planning figures and statuses. `users.admin_unit_id` is the unit a user's data scope is anchored at.
 */
export class AdminUnits1793300000100 implements MigrationInterface {
  name = 'AdminUnits1793300000100';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS ltree`);
    await q.query(`
      CREATE TABLE "admin_units" (
        "id" character varying(40) NOT NULL,
        "type" character varying(20) NOT NULL,
        "code" character varying(40),
        "name" character varying(160) NOT NULL,
        "name_am" character varying(160),
        "name_om" character varying(160),
        "parent_id" character varying(40),
        "path" ltree NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "sort" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_units" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_admin_units_path" UNIQUE ("path"),
        CONSTRAINT "FK_admin_units_parent" FOREIGN KEY ("parent_id") REFERENCES "admin_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_admin_units_type" CHECK (type IN ('COUNTRY', 'REGION', 'ZONE', 'WOREDA', 'KEBELE', 'UNION', 'PC', 'CITY_ADMIN', 'SPECIAL_WOREDA')),
        CONSTRAINT "CHK_admin_units_root" CHECK ((type = 'COUNTRY') = (parent_id IS NULL))
      )`);
    await q.query(`CREATE INDEX "IDX_admin_units_parent_id" ON "admin_units" ("parent_id")`);
    await q.query(`CREATE INDEX "IDX_admin_units_path_gist" ON "admin_units" USING gist ("path")`);
    await backfillAdminUnits(q);

    await q.query(`ALTER TABLE "users" ADD COLUMN "admin_unit_id" character varying(40)`);
    await q.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_users_admin_unit" FOREIGN KEY ("admin_unit_id") REFERENCES "admin_units"("id") ON DELETE RESTRICT`);
    await q.query(`CREATE INDEX "IDX_users_admin_unit_id" ON "users" ("admin_unit_id")`);
    await backfillUserUnits(q);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN "admin_unit_id"`);
    await q.query(`DROP TABLE "admin_units"`);
    // The ltree extension is left installed (harmless; other objects may use it).
  }
}
