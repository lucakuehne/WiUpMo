import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fasst die Installationsauftraege zusammen, die in einem Zug angelegt wurden.
 *
 * Bisher stand jeder Auftrag fuer sich: Wer zwanzig Geraete auswaehlte, bekam
 * zwanzig Zeilen ohne Bezug zueinander, und die Frage "wie weit ist die
 * Installation von heute Morgen?" liess sich nur ueber Zeitstempel beantworten.
 * Die Installation haelt fest, was angefordert wurde — Umfang, Zeitpunkt,
 * Streuung, wie viele Geraete gewaehlt und warum welche uebergangen wurden —,
 * die Auftraege je Geraet bleiben, was sie waren.
 *
 * Bestehende Auftraege werden nachtraeglich gruppiert: gleicher Ersteller,
 * gleicher Umfang und hoechstens eine Minute Abstand zum vorigen Auftrag. So
 * lange dauerte das Anlegen auch bei vielen Geraeten nie. Was dabei nicht mehr
 * bekannt ist — gewaehlte und uebergangene Geraete —, steht wie angelegt bzw.
 * leer.
 */
export class Installations1793836800000 implements MigrationInterface {
  name = 'Installations1793836800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "update_installations" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "scope"             "install_job_scope" NOT NULL,
        "update_ids"        uuid[] NOT NULL DEFAULT '{}',
        "classifications"   text[] NOT NULL DEFAULT '{}',
        "not_before"        timestamptz NOT NULL,
        "spread_minutes"    int NOT NULL DEFAULT 0,
        "requested_devices" int NOT NULL,
        "skipped"           jsonb,
        "created_by"        text NOT NULL,
        "created_at"        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_update_installations_created" ON "update_installations" ("created_at" DESC)`,
    );

    await queryRunner.query(`ALTER TABLE "update_install_jobs" ADD COLUMN "installation_id" uuid`);

    // Inseln gleicher Auftraege: Eine neue beginnt, wo der Abstand zum
    // vorigen mehr als eine Minute betraegt. Die Gruppen-CTE enthaelt eine
    // fluechtige Funktion und wird deshalb genau einmal ausgewertet — beide
    // Verwendungen sehen dieselben IDs.
    await queryRunner.query(`
      WITH ordered AS (
        SELECT j.id, j.created_by, j.scope, j.update_ids, j.classifications, j.created_at, j.not_before,
               CASE WHEN j.created_at - lag(j.created_at) OVER w <= interval '1 minute' THEN 0 ELSE 1 END AS starts
          FROM update_install_jobs j
        WINDOW w AS (PARTITION BY j.created_by, j.scope, j.update_ids, j.classifications ORDER BY j.created_at, j.id)
      ),
      numbered AS (
        SELECT o.*,
               sum(o.starts) OVER (
                 PARTITION BY o.created_by, o.scope, o.update_ids, o.classifications
                 ORDER BY o.created_at, o.id
               ) AS grp
          FROM ordered o
      ),
      groups AS (
        SELECT gen_random_uuid() AS installation_id, created_by, scope, update_ids, classifications, grp,
               min(created_at) AS created_at, min(not_before) AS not_before,
               ceil(extract(epoch FROM max(not_before) - min(not_before)) / 60)::int AS spread_minutes,
               count(*)::int AS requested_devices
          FROM numbered
         GROUP BY created_by, scope, update_ids, classifications, grp
      ),
      inserted AS (
        INSERT INTO update_installations
          (id, scope, update_ids, classifications, not_before, spread_minutes, requested_devices, created_by, created_at)
        SELECT installation_id, scope, update_ids, classifications, not_before, spread_minutes, requested_devices,
               created_by, created_at
          FROM groups
        RETURNING id
      )
      UPDATE update_install_jobs j
         SET installation_id = g.installation_id
        FROM numbered n
        JOIN groups g USING (created_by, scope, update_ids, classifications, grp)
       WHERE j.id = n.id
    `);

    // Erst nach dem Nachtragen: Die eingefuegten Installationen sind fuer die
    // Pruefung in derselben Anweisung nicht verlaesslich sichtbar.
    await queryRunner.query(`ALTER TABLE "update_install_jobs" ALTER COLUMN "installation_id" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "update_install_jobs"
         ADD CONSTRAINT "fk_update_install_jobs_installation"
         FOREIGN KEY ("installation_id") REFERENCES "update_installations" ("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_update_install_jobs_installation" ON "update_install_jobs" ("installation_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "update_install_jobs" DROP COLUMN IF EXISTS "installation_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "update_installations"`);
  }
}
