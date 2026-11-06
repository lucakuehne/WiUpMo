import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Neustarts, die in der Oberflaeche angefordert werden.
 *
 * Gebaut wie die Installationen: Eine Anfrage buendelt, was in einem Zug fuer
 * mehrere Geraete angelegt wurde, und haelt die Regeln fest, nach denen der
 * Benutzer verschieben darf — eine spaetere Aenderung der Einstellungen
 * betrifft laufende Auftraege nicht. Je Geraet gibt es einen Auftrag, und
 * hoechstens einen offenen.
 *
 * Abgeschlossen wird ein Auftrag nicht durch die Meldung des Agents, sondern
 * durch den letzten Neustart, den das Geraet danach meldet: Erst der beweist,
 * dass es geklappt hat. Verglichen wird mit `restarting_at`, dem Zeitpunkt, zu
 * dem der Agent den Neustart einleitete — beide Werte stammen von der Uhr des
 * Geraets, eine falsch gehende Uhr verschiebt sie gleichermassen. Startet der
 * Benutzer selbst neu, bevor der Agent dazu kam, zaehlt die Anlage des
 * Auftrags mit fuenf Minuten Spielraum fuer die Uhr.
 *
 * `events` haelt die Rueckmeldungen in zeitlicher Folge fest — gezeigt,
 * verschoben bis wann und von wem, Neustart eingeleitet.
 */
export class RestartJobs1794268800000 implements MigrationInterface {
  name = 'RestartJobs1794268800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "restart_job_state" AS ENUM
         ('pending', 'delivered', 'notified', 'deferred', 'restarting', 'done', 'failed', 'expired', 'cancelled')`,
    );

    await queryRunner.query(`
      CREATE TABLE "restart_requests" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "reason"            text,
        "settings"          jsonb NOT NULL,
        "requested_devices" int NOT NULL,
        "skipped"           jsonb,
        "created_by"        text NOT NULL,
        "created_at"        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_restart_requests_created" ON "restart_requests" ("created_at" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE "restart_jobs" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "request_id"     uuid NOT NULL REFERENCES "restart_requests" ("id") ON DELETE CASCADE,
        "device_id"      uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "state"          "restart_job_state" NOT NULL DEFAULT 'pending',
        "expires_at"     timestamptz NOT NULL,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "delivered_at"   timestamptz,
        "notified_at"    timestamptz,
        "deadline_at"    timestamptz,
        "deferrals"      int NOT NULL DEFAULT 0,
        "deferred_until" timestamptz,
        "last_user"      text,
        "restarting_at"  timestamptz,
        "completed_at"   timestamptz,
        "error"          text,
        "events"         jsonb NOT NULL DEFAULT '[]'::jsonb
      )
    `);

    // Wie bei den Installationen: ein offener Auftrag je Geraet.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_restart_jobs_one_open"
         ON "restart_jobs" ("device_id")
        WHERE "state" IN ('pending', 'delivered', 'notified', 'deferred', 'restarting')`,
    );
    await queryRunner.query(`CREATE INDEX "idx_restart_jobs_request" ON "restart_jobs" ("request_id")`);
    await queryRunner.query(
      `CREATE INDEX "idx_restart_jobs_device_created" ON "restart_jobs" ("device_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "restart_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "restart_requests"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "restart_job_state"`);
  }
}
