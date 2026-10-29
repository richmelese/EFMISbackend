import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage B4: generic workflow engine tables. `workflow_actions` is write-once (same trigger function as audit_log and
 * approval_actions). Legacy `approval_actions` stays read-only; WorkflowService.history() merges both.
 */
export class Workflow1793300000200 implements MigrationInterface {
  name = 'Workflow1793300000200';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "workflow_cases" (
        "id" character varying(40) NOT NULL,
        "entity_type" character varying(40) NOT NULL,
        "entity_id" character varying(60) NOT NULL,
        "definition" character varying(40) NOT NULL,
        "level" character varying(20) NOT NULL,
        "status" character varying(30) NOT NULL,
        "assignee_unit_id" character varying(40) NOT NULL,
        "origin_unit_id" character varying(40) NOT NULL,
        "season_id" character varying(40),
        "due_at" TIMESTAMP WITH TIME ZONE,
        "escalation_level" integer NOT NULL DEFAULT 0,
        "version" integer NOT NULL DEFAULT 1,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflow_cases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workflow_cases_assignee" FOREIGN KEY ("assignee_unit_id") REFERENCES "admin_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_workflow_cases_origin" FOREIGN KEY ("origin_unit_id") REFERENCES "admin_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_workflow_cases_season" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE UNIQUE INDEX "UQ_workflow_cases_entity" ON "workflow_cases" ("definition", "entity_type", "entity_id", "season_id") NULLS NOT DISTINCT`);
    await q.query(`CREATE INDEX "IDX_workflow_cases_entity" ON "workflow_cases" ("entity_type", "entity_id")`);
    await q.query(`CREATE INDEX "IDX_workflow_cases_assignee" ON "workflow_cases" ("assignee_unit_id")`);
    await q.query(`CREATE INDEX "IDX_workflow_cases_due" ON "workflow_cases" ("due_at") WHERE closed_at IS NULL`);

    await q.query(`
      CREATE TABLE "workflow_actions" (
        "id" BIGSERIAL NOT NULL,
        "case_id" character varying(40) NOT NULL,
        "action" character varying(30) NOT NULL,
        "from_status" character varying(30),
        "to_status" character varying(30) NOT NULL,
        "level" character varying(20) NOT NULL,
        "actor_id" character varying(40),
        "actor_name" character varying(160) NOT NULL,
        "comments" text,
        "details" jsonb,
        "signature_id" character varying(40),
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workflow_actions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_workflow_actions_case" FOREIGN KEY ("case_id") REFERENCES "workflow_cases"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "IDX_workflow_actions_case" ON "workflow_actions" ("case_id")`);
    await q.query(`CREATE TRIGGER workflow_actions_immutable BEFORE UPDATE OR DELETE ON "workflow_actions" FOR EACH ROW EXECUTE FUNCTION efmis_forbid_mutation()`);
    await q.query(`CREATE TRIGGER workflow_actions_no_truncate BEFORE TRUNCATE ON "workflow_actions" FOR EACH STATEMENT EXECUTE FUNCTION efmis_forbid_mutation()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "workflow_actions"`);
    await q.query(`DROP TABLE "workflow_cases"`);
  }
}
