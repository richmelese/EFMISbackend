import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stage B5: transactional outbox for outgoing messages (sent with retries by the outbox relay / BullMQ worker). */
export class Outbox1793300000300 implements MigrationInterface {
  name = 'Outbox1793300000300';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "outbox_messages" (
        "id" character varying(40) NOT NULL,
        "channel" character varying(20) NOT NULL,
        "payload" jsonb NOT NULL,
        "status" character varying(10) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 8,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "ack_within_hours" integer,
        "ack_due_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "provider_ref" character varying(120),
        "dedupe_key" character varying(160),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "acked_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbox_messages" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_outbox_channel" CHECK (channel IN ('EMAIL', 'SMS', 'PUSH', 'WEBHOOK', 'EXTERNAL_API')),
        CONSTRAINT "CHK_outbox_status" CHECK (status IN ('PENDING', 'FAILED', 'SENT', 'ACKED', 'DEAD'))
      )`);
    await q.query(`CREATE INDEX "IDX_outbox_due" ON "outbox_messages" ("status", "next_attempt_at")`);
    await q.query(`CREATE UNIQUE INDEX "UQ_outbox_dedupe" ON "outbox_messages" ("dedupe_key") WHERE dedupe_key IS NOT NULL`);
    await q.query(`CREATE INDEX "IDX_outbox_ack_due" ON "outbox_messages" ("ack_due_at") WHERE status = 'SENT'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "outbox_messages"`);
  }
}
