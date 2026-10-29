import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Electronic signatures get their own HMAC key (SIGNATURE_SECRET) instead of the JWT secret. Each signature records
 * the key that produced it so verification picks the right one: rows created before this migration were signed with
 * the JWT secret and keep 'jwt-legacy'; new rows are written with 'sig-v1'.
 */
export class SignatureKeyId1793200000000 implements MigrationInterface {
  name = 'SignatureKeyId1793200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "signatures" ADD COLUMN "key_id" character varying(20) NOT NULL DEFAULT 'jwt-legacy'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "signatures" DROP COLUMN "key_id"`);
  }
}
