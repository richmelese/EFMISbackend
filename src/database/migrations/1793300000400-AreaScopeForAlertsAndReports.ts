import { MigrationInterface, QueryRunner } from 'typeorm';
import { backfillAlertUnits } from '../../modules/alerts/alert-units';
import { backfillReportRegionUnits } from '../../modules/reports/report-region-units';

/**
 * Alerts and daily reports get an administrative unit so field and regional officers only see their own area.
 * alerts.unit_id: from area-sourced alerts (kebele/woreda/zone/region); others stay national (null).
 * report_regions.admin_unit_id: report region ids mapped onto admin_units regions.
 */
export class AreaScopeForAlertsAndReports1793300000400 implements MigrationInterface {
  name = 'AreaScopeForAlertsAndReports1793300000400';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "alerts" ADD COLUMN "unit_id" character varying(40)`);
    await q.query(`ALTER TABLE "alerts" ADD CONSTRAINT "FK_alerts_unit" FOREIGN KEY ("unit_id") REFERENCES "admin_units"("id") ON DELETE SET NULL`);
    await q.query(`CREATE INDEX "IDX_alerts_unit_id" ON "alerts" ("unit_id")`);
    await backfillAlertUnits(q);

    await q.query(`ALTER TABLE "report_regions" ADD COLUMN "admin_unit_id" character varying(40)`);
    await q.query(`ALTER TABLE "report_regions" ADD CONSTRAINT "FK_report_regions_unit" FOREIGN KEY ("admin_unit_id") REFERENCES "admin_units"("id") ON DELETE SET NULL`);
    await backfillReportRegionUnits(q);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "report_regions" DROP COLUMN "admin_unit_id"`);
    await q.query(`ALTER TABLE "alerts" DROP COLUMN "unit_id"`);
  }
}
