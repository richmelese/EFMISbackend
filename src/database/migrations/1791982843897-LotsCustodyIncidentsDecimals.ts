import { MigrationInterface, QueryRunner } from "typeorm";

export class LotsCustodyIncidentsDecimals1791982843897 implements MigrationInterface {
    name = 'LotsCustodyIncidentsDecimals1791982843897'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "inventory_lots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "warehouse_id" uuid NOT NULL, "product_id" uuid NOT NULL, "lot_number" character varying(64) NOT NULL, "qc_status" character varying(12) NOT NULL DEFAULT 'PASSED', "qc_reference" character varying(80), "qc_notes" text, "qc_decided_by" character varying(160), "qc_decided_at" TIMESTAMP WITH TIME ZONE, "expiry_date" date, "on_hand_quantity" numeric(14,3) NOT NULL DEFAULT '0', "reserved_quantity" numeric(14,3) NOT NULL DEFAULT '0', "source_lot_id" uuid, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_4169a4d8ae62a4b2c212411a74b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d152d58a55f56abe88857531e1" ON "inventory_lots" ("warehouse_id", "product_id", "qc_status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e2aa15810bd31b18db31cdf683" ON "inventory_lots" ("warehouse_id", "product_id", "lot_number") `);
        await queryRunner.query(`CREATE TABLE "inventory_allocations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "reference_type" character varying(12) NOT NULL, "reference_id" character varying(60) NOT NULL, "lot_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, "product_id" uuid NOT NULL, "reserved_quantity" numeric(14,3) NOT NULL DEFAULT '0', "consumed_quantity" numeric(14,3) NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e81a131de3eb811c601b1fc2bbd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_325a0184b4bc82921294f6c446" ON "inventory_allocations" ("lot_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d01bc14d8671b191fd54450974" ON "inventory_allocations" ("reference_type", "reference_id") `);
        await queryRunner.query(`CREATE TABLE "shipment_scan_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "shipment_id" uuid NOT NULL, "trip_id" uuid, "scan_type" character varying(24) NOT NULL, "lot_number" character varying(64) NOT NULL, "bag_count" integer, "result" character varying(10) NOT NULL, "scanned_by" character varying(40) NOT NULL, "scanned_by_name" character varying(160) NOT NULL, "device_serial" character varying(64), "warehouse_id" uuid, "latitude" double precision, "longitude" double precision, "location_label" character varying(160), "notes" text, "client_scan_id" character varying(80), "scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ca8d3ab1f9bcd30ebb8cd2fa204" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ec23de0bbfd587ad9188bbee0a" ON "shipment_scan_events" ("client_scan_id") WHERE client_scan_id IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_61e7b5cfd6f3f41264e317d1b2" ON "shipment_scan_events" ("shipment_id", "scanned_at") `);
        await queryRunner.query(`CREATE TABLE "security_incidents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "incident_number" character varying(20) NOT NULL, "shipment_id" uuid, "trip_id" uuid, "truck_id" uuid, "incident_type" character varying(24) NOT NULL, "severity" character varying(10) NOT NULL DEFAULT 'HIGH', "description" text NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "latitude" double precision, "longitude" double precision, "location_label" character varying(160), "quantity_affected_mt" numeric(14,3), "police_report_no" character varying(64), "police_station" character varying(160), "status" character varying(14) NOT NULL DEFAULT 'OPEN', "resolution" text, "resolved_by" character varying(160), "resolved_at" TIMESTAMP WITH TIME ZONE, "reported_by" character varying(40) NOT NULL, "reported_by_name" character varying(160) NOT NULL, "alert_id" character varying(40), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ae4bb9cdce807edf3f0d3526b69" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_588676fe52f29f019bafbbaa76" ON "security_incidents" ("incident_number") `);
        await queryRunner.query(`CREATE INDEX "IDX_1a18a26697ab8439ab23537578" ON "security_incidents" ("shipment_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_75e5f543e828fa872218d0b5e0" ON "security_incidents" ("trip_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_32e0a0dcc0dd004dbbb044987d" ON "security_incidents" ("status", "occurred_at") `);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ADD "lot_id" uuid`);
        await queryRunner.query(`ALTER TABLE "shipments" ADD "waybill_number" character varying(64)`);
        await queryRunner.query(`ALTER TABLE "warehouses" ALTER COLUMN "capacity_mt" TYPE numeric(14,3) USING round("capacity_mt"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_balances" ALTER COLUMN "on_hand_quantity" TYPE numeric(14,3) USING round("on_hand_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_balances" ALTER COLUMN "reserved_quantity" TYPE numeric(14,3) USING round("reserved_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "quantity" TYPE numeric(14,3) USING round("quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "on_hand_delta" TYPE numeric(14,3) USING round("on_hand_delta"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "reserved_delta" TYPE numeric(14,3) USING round("reserved_delta"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "on_hand_after" TYPE numeric(14,3) USING round("on_hand_after"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "reserved_after" TYPE numeric(14,3) USING round("reserved_after"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "planned_quantity" TYPE numeric(14,3) USING round("planned_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "reserved_quantity" TYPE numeric(14,3) USING round("reserved_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "loaded_quantity" TYPE numeric(14,3) USING round("loaded_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "delivered_quantity" TYPE numeric(14,3) USING round("delivered_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "trip_shipments" ALTER COLUMN "loaded_quantity" TYPE numeric(14,3) USING round("loaded_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "trip_shipments" ALTER COLUMN "loading_discrepancy" TYPE numeric(14,3) USING round("loading_discrepancy"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "deliveries" ALTER COLUMN "received_quantity" TYPE numeric(14,3) USING round("received_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "deliveries" ALTER COLUMN "discrepancy_quantity" TYPE numeric(14,3) USING round("discrepancy_quantity"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "vehicle_types" ALTER COLUMN "max_capacity_value" TYPE numeric(14,3) USING round("max_capacity_value"::numeric, 3)`);
        await queryRunner.query(`ALTER TABLE "trucks" ALTER COLUMN "capacity_value" TYPE numeric(14,3) USING round("capacity_value"::numeric, 3)`);
        await queryRunner.query(`CREATE INDEX "IDX_15d35401837a9343c5910605e3" ON "inventory_transactions" ("lot_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_aafa92b6c823d62ba9f8280780" ON "shipments" ("waybill_number") WHERE waybill_number IS NOT NULL`);
        // Waybill numbers issued at dispatch: WB-<year>-<n>
        await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS "waybill_number_seq" START 1`);
        // Existing stock becomes one PASSED opening lot per warehouse × product, with open reservations and in-transit
        // loads attached, so every later movement is lot-tracked (same SQL as src/modules/logistics/warehouses/lot-backfill.ts).
        await queryRunner.query(`INSERT INTO inventory_lots (warehouse_id, product_id, lot_number, qc_status, on_hand_quantity, reserved_quantity)
          SELECT b.warehouse_id, b.product_id, 'OPENING-' || w.code || '-' || p.sku, 'PASSED', b.on_hand_quantity, b.reserved_quantity
            FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN products p ON p.id = b.product_id
           WHERE (b.on_hand_quantity > 0 OR b.reserved_quantity > 0)
             AND NOT EXISTS (SELECT 1 FROM inventory_lots l WHERE l.warehouse_id = b.warehouse_id AND l.product_id = b.product_id)`);
        await queryRunner.query(`INSERT INTO inventory_allocations (reference_type, reference_id, lot_id, warehouse_id, product_id, reserved_quantity, consumed_quantity)
          SELECT 'SHIPMENT', s.id::text, l.id, s.origin_warehouse_id, s.product_id,
                 CASE WHEN s.status IN ('IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'CLOSED', 'DELIVERY_FAILED') THEN 0 ELSE s.reserved_quantity END,
                 CASE WHEN s.status IN ('IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'CLOSED', 'DELIVERY_FAILED') THEN COALESCE(s.loaded_quantity, 0) ELSE 0 END
            FROM shipments s
            JOIN inventory_lots l ON l.warehouse_id = s.origin_warehouse_id AND l.product_id = s.product_id AND l.lot_number LIKE 'OPENING-%'
           WHERE s.product_id IS NOT NULL
             AND (s.reserved_quantity > 0 OR (s.status IN ('IN_TRANSIT', 'ARRIVED') AND COALESCE(s.loaded_quantity, 0) > 0))
             AND NOT EXISTS (SELECT 1 FROM inventory_allocations a WHERE a.reference_type = 'SHIPMENT' AND a.reference_id = s.id::text)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP SEQUENCE IF EXISTS "waybill_number_seq"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aafa92b6c823d62ba9f8280780"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_15d35401837a9343c5910605e3"`);
        await queryRunner.query(`ALTER TABLE "trucks" ALTER COLUMN "capacity_value" TYPE double precision USING "capacity_value"::double precision`);
        await queryRunner.query(`ALTER TABLE "vehicle_types" ALTER COLUMN "max_capacity_value" TYPE double precision USING "max_capacity_value"::double precision`);
        await queryRunner.query(`ALTER TABLE "deliveries" ALTER COLUMN "discrepancy_quantity" TYPE double precision USING "discrepancy_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "deliveries" ALTER COLUMN "received_quantity" TYPE double precision USING "received_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "trip_shipments" ALTER COLUMN "loading_discrepancy" TYPE double precision USING "loading_discrepancy"::double precision`);
        await queryRunner.query(`ALTER TABLE "trip_shipments" ALTER COLUMN "loaded_quantity" TYPE double precision USING "loaded_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "delivered_quantity" TYPE double precision USING "delivered_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "loaded_quantity" TYPE double precision USING "loaded_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "reserved_quantity" TYPE double precision USING "reserved_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "shipments" ALTER COLUMN "planned_quantity" TYPE double precision USING "planned_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "reserved_after" TYPE double precision USING "reserved_after"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "on_hand_after" TYPE double precision USING "on_hand_after"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "reserved_delta" TYPE double precision USING "reserved_delta"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "on_hand_delta" TYPE double precision USING "on_hand_delta"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ALTER COLUMN "quantity" TYPE double precision USING "quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_balances" ALTER COLUMN "reserved_quantity" TYPE double precision USING "reserved_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "inventory_balances" ALTER COLUMN "on_hand_quantity" TYPE double precision USING "on_hand_quantity"::double precision`);
        await queryRunner.query(`ALTER TABLE "warehouses" ALTER COLUMN "capacity_mt" TYPE double precision USING "capacity_mt"::double precision`);
        await queryRunner.query(`ALTER TABLE "shipments" DROP COLUMN "waybill_number"`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" DROP COLUMN "lot_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_32e0a0dcc0dd004dbbb044987d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_75e5f543e828fa872218d0b5e0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1a18a26697ab8439ab23537578"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_588676fe52f29f019bafbbaa76"`);
        await queryRunner.query(`DROP TABLE "security_incidents"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_61e7b5cfd6f3f41264e317d1b2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ec23de0bbfd587ad9188bbee0a"`);
        await queryRunner.query(`DROP TABLE "shipment_scan_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d01bc14d8671b191fd54450974"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_325a0184b4bc82921294f6c446"`);
        await queryRunner.query(`DROP TABLE "inventory_allocations"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e2aa15810bd31b18db31cdf683"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d152d58a55f56abe88857531e1"`);
        await queryRunner.query(`DROP TABLE "inventory_lots"`);
    }

}
