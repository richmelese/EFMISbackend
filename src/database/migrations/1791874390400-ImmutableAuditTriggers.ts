import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * REQ-1.7-002 / REQ-1.1-007: audit trail and approval records are write-once (cannot be modified or deleted).
 * Enforced in the database so no application code path (or direct SQL) can alter history.
 */
export class ImmutableAuditTriggers1791874390400 implements MigrationInterface {
  name = 'ImmutableAuditTriggers1791874390400';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION efmis_forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is immutable (write-once audit record)', TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql;
    `);
    for (const table of ['audit_log', 'approval_actions']) {
      await q.query(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION efmis_forbid_mutation()`);
      await q.query(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION efmis_forbid_mutation()`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['audit_log', 'approval_actions']) {
      await q.query(`DROP TRIGGER IF EXISTS ${table}_immutable ON "${table}"`);
      await q.query(`DROP TRIGGER IF EXISTS ${table}_no_truncate ON "${table}"`);
    }
    await q.query(`DROP FUNCTION IF EXISTS efmis_forbid_mutation()`);
  }
}
