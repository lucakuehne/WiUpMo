import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auftraege, offene Updates auf einem Geraet zu installieren.
 *
 * Gebaut wie die Auftraege zum Selbst-Update: Der Auftrag liegt hier, bis sich
 * das Geraet meldet, und geht mit der Check-in-Antwort hinaus. Ausgefuehrt wird
 * er vom Agent ab 0.7.0; aeltere bekommen ihn nicht.
 *
 * Der Umfang ist entweder eine Auswahl einzelner Updates oder eine Menge von
 * Update-Typen. `update_ids` sind Katalog-IDs (Tabelle `updates`) und nur bei
 * `scope = 'selected'` gefuellt, `classifications` nur bei `scope = 'types'`.
 * Ein Fremdschluessel auf ein Array geht in PostgreSQL nicht; der Katalog
 * loescht ohnehin nie.
 */
export class InstallJobs1793577600000 implements MigrationInterface {
  name = 'InstallJobs1793577600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "install_job_state" AS ENUM ('pending', 'delivered', 'running', 'done', 'failed', 'expired', 'cancelled')`,
    );
    await queryRunner.query(`CREATE TYPE "install_job_scope" AS ENUM ('types', 'selected')`);

    await queryRunner.query(`
      CREATE TABLE "update_install_jobs" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id"       uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "scope"           "install_job_scope" NOT NULL,
        "update_ids"      uuid[] NOT NULL DEFAULT '{}',
        "classifications" text[] NOT NULL DEFAULT '{}',
        "state"           "install_job_state" NOT NULL DEFAULT 'pending',
        "not_before"      timestamptz NOT NULL,
        "expires_at"      timestamptz NOT NULL,
        "created_by"      text NOT NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "delivered_at"    timestamptz,
        "started_at"      timestamptz,
        "completed_at"    timestamptz,
        "result"          jsonb,
        "error"           text
      )
    `);

    // Hoechstens ein offener Auftrag je Geraet. Als Index statt als Pruefung im
    // Dienst: Zwei gleichzeitige Anfragen koennten sonst beide durchkommen.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_update_install_jobs_one_open"
         ON "update_install_jobs" ("device_id")
        WHERE "state" IN ('pending', 'delivered', 'running')`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_update_install_jobs_device_created"
         ON "update_install_jobs" ("device_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "update_install_jobs"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "install_job_scope"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "install_job_state"`);
  }
}
