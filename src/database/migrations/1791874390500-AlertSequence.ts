import { MigrationInterface, QueryRunner } from 'typeorm';

/** Collision-free alert ids (ALT-<year>-<n>). Seeded alerts use 0091–0094, so the sequence starts at 95. */
export class AlertSequence1791874390500 implements MigrationInterface {
  name = 'AlertSequence1791874390500';

  public async up(q: QueryRunner): Promise<void> {
    await q.query('CREATE SEQUENCE IF NOT EXISTS alert_seq START WITH 95');
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP SEQUENCE IF EXISTS alert_seq');
  }
}
