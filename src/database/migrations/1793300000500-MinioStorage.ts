import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Files move from the local filesystem to MinIO (MINIO_STORAGE_PLAN.md). Stored locations become object keys inside
 * one bucket per kind of file: "<owner id>/<file name>". The bytes are copied by `npm run storage:import-local`.
 * Also adds the retention queue (write-once retention applied after an upload's transaction commits).
 */
export class MinioStorage1793300000500 implements MigrationInterface {
  name = 'MinioStorage1793300000500';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "storage_retention_queue" (
        "id" BIGSERIAL NOT NULL,
        "bucket" character varying(30) NOT NULL,
        "object_key" text NOT NULL,
        "version_id" character varying(100),
        "retain_until" TIMESTAMP WITH TIME ZONE NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_storage_retention_queue" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_storage_retention_bucket" CHECK (bucket IN ('FARMER_DOCUMENTS', 'DRIVER_DOCUMENTS', 'DELIVERY_PROOFS'))
      )`);

    // farmer_documents: absolute disk path → "<farmerId>/<file>"
    await q.query(`ALTER TABLE "farmer_documents" RENAME COLUMN "storage_path" TO "storage_key"`);
    await q.query(`UPDATE farmer_documents SET storage_key = farmer_id || '/' || regexp_replace(storage_key, '^.*[/\\\\]', '')`);
    // driver_documents: "driver-documents/<file>" → "<driverId>/<file>"
    await q.query(`UPDATE driver_documents SET secure_storage_key = driver_id || '/' || regexp_replace(secure_storage_key, '^.*/', '')`);
    // deliveries: "proof-of-delivery/<file>" → "<shipmentId>/<file>"
    await q.query(`UPDATE deliveries SET proof_of_delivery_storage_key = shipment_id || '/' || regexp_replace(proof_of_delivery_storage_key, '^.*/', '')
                   WHERE proof_of_delivery_storage_key IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE deliveries SET proof_of_delivery_storage_key = 'proof-of-delivery/' || regexp_replace(proof_of_delivery_storage_key, '^.*/', '')
                   WHERE proof_of_delivery_storage_key IS NOT NULL`);
    await q.query(`UPDATE driver_documents SET secure_storage_key = 'driver-documents/' || regexp_replace(secure_storage_key, '^.*/', '')`);
    // the original absolute directory is not known any more: keep the relative key
    await q.query(`ALTER TABLE "farmer_documents" RENAME COLUMN "storage_key" TO "storage_path"`);
    await q.query(`DROP TABLE "storage_retention_queue"`);
  }
}
