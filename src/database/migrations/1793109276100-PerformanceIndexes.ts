import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Indexes for columns that are filtered/joined on in hot paths but had none (REQ-1.7-001 data segmentation
 * queries, fleet dispatch screen, audit trail). Postgres does not auto-index a foreign key's referencing column,
 * so each of these was a sequential scan despite the FK constraint already existing.
 */
export class PerformanceIndexes1793109276100 implements MigrationInterface {
    name = 'PerformanceIndexes1793109276100'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Data segmentation: WOREDA/ZONE-role users filter farmers by these (scopeCondition/inScope).
        await queryRunner.query(`CREATE INDEX "IDX_farmers_woreda_id" ON "farmers" ("woreda_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_farmers_zone_id" ON "farmers" ("zone_id")`);

        // Administrative hierarchy drill-down/aggregation (reviews, aggregation services).
        await queryRunner.query(`CREATE INDEX "IDX_kebeles_woreda_id" ON "kebeles" ("woreda_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_woredas_zone_id" ON "woredas" ("zone_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_zones_region_id" ON "zones" ("region_id")`);

        // WAREHOUSE_OPERATOR truck-visibility check (fleet.service.ts) joins trip_shipments -> shipments
        // filtered by either warehouse end.
        await queryRunner.query(`CREATE INDEX "IDX_shipments_origin_warehouse_id" ON "shipments" ("origin_warehouse_id")`);
        await queryRunner.query(`CREATE INDEX "IDX_shipments_destination_warehouse_id" ON "shipments" ("destination_warehouse_id")`);

        // Dispatcher fleet list filters by these (fleet.service.ts).
        await queryRunner.query(`CREATE INDEX "IDX_trucks_operational_status" ON "trucks" ("operational_status")`);
        await queryRunner.query(`CREATE INDEX "IDX_trucks_availability_status" ON "trucks" ("availability_status")`);
        await queryRunner.query(`CREATE INDEX "IDX_trucks_vehicle_type_id" ON "trucks" ("vehicle_type_id")`);

        // User activity/audit page (UsersService.userAudit) scans audit_log by user_id.
        await queryRunner.query(`CREATE INDEX "IDX_audit_log_user_id" ON "audit_log" ("user_id")`);

        // Inventory transaction history filtered/ordered by date alone (warehouses.service.ts).
        await queryRunner.query(`CREATE INDEX "IDX_inventory_transactions_created_at" ON "inventory_transactions" ("created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_inventory_transactions_created_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_log_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_trucks_vehicle_type_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_trucks_availability_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_trucks_operational_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_shipments_destination_warehouse_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_shipments_origin_warehouse_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_zones_region_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_woredas_zone_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_kebeles_woreda_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_farmers_zone_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_farmers_woreda_id"`);
    }

}
