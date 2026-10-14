import { MigrationInterface, QueryRunner } from "typeorm";

export class RbacUserManagement1791981840314 implements MigrationInterface {
    name = 'RbacUserManagement1791981840314'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "permissions" ("key" character varying(60) NOT NULL, "group" character varying(60) NOT NULL, "description" text NOT NULL, "sensitive" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_017943867ed5ceef9c03edd9745" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TABLE "role_permissions" ("role_id" character varying(40) NOT NULL, "permission_key" character varying(60) NOT NULL, "granted_by" character varying(40), "granted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_064de54701f3ac10466efa130a5" PRIMARY KEY ("role_id", "permission_key"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8b7b2f0714335aa02b2171f474" ON "role_permissions" ("permission_key") `);
        await queryRunner.query(`ALTER TABLE "roles" ADD "base_role" character varying(40)`);
        await queryRunner.query(`ALTER TABLE "roles" ADD "is_system" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "roles" ADD "active" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "roles" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "roles" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "users" ADD "tokens_valid_after" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD "must_change_password" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "users" ADD "password_changed_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD "created_by" character varying(40)`);
        await queryRunner.query(`ALTER TABLE "users" ADD "deactivation_reason" text`);
        // Widen in place (the generated DROP/ADD COLUMN would erase every user's role).
        await queryRunner.query(`ALTER TABLE "roles" ALTER COLUMN "id" TYPE character varying(40)`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" TYPE character varying(40)`);
        // Existing roles are the built-in system roles; each is its own base role.
        await queryRunner.query(`UPDATE "roles" SET "base_role" = "id", "is_system" = true`);
        // Any user whose role row is missing gets one, so the new foreign key can be created (no user is left without a role).
        await queryRunner.query(`INSERT INTO "roles" ("id", "name", "level", "base_role", "is_system")
          SELECT DISTINCT u."role", u."role", 'National', u."role", true FROM "users" u
          WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."id" = u."role")`);
        await queryRunner.query(`ALTER TABLE "role_permissions" ADD CONSTRAINT "FK_178199805b901ccd220ab7740ec" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "role_permissions" ADD CONSTRAINT "FK_8b7b2f0714335aa02b2171f4741" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_ace513fa30d485cfd25c11a9e4a" FOREIGN KEY ("role") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_ace513fa30d485cfd25c11a9e4a"`);
        await queryRunner.query(`ALTER TABLE "role_permissions" DROP CONSTRAINT "FK_8b7b2f0714335aa02b2171f4741"`);
        await queryRunner.query(`ALTER TABLE "role_permissions" DROP CONSTRAINT "FK_178199805b901ccd220ab7740ec"`);
        // Custom roles (and users on them) cannot survive the rollback to 20-character built-in roles only.
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" TYPE character varying(20)`);
        await queryRunner.query(`ALTER TABLE "roles" ALTER COLUMN "id" TYPE character varying(20)`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deactivation_reason"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "created_by"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_changed_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "must_change_password"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tokens_valid_after"`);
        await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "active"`);
        await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "is_system"`);
        await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "base_role"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8b7b2f0714335aa02b2171f474"`);
        await queryRunner.query(`DROP TABLE "role_permissions"`);
        await queryRunner.query(`DROP TABLE "permissions"`);
    }

}
