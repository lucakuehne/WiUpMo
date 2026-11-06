import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fasst die Update-Auftraege des Agents zusammen, die in einem Zug angelegt
 * wurden — ein Ausrollen, wie die Installation bei den Windows-Updates.
 *
 * `scope` haelt fest, wofuer beauftragt wurde: `outdated` sind alle aktiven
 * Geraete mit abweichender Version, `selected` eine Auswahl. Nachgetragene
 * Ausrollen stehen auf `unknown`, ebenso fehlt bei ihnen, wer sie angelegt hat
 * — beides wurde bisher nicht gespeichert.
 *
 * Bestehende Auftraege werden nach Zielversion und Zeitpunkt gruppiert: Ein
 * Ausrollen legte seine Auftraege seit jeher mit einer einzigen Anweisung an,
 * sie tragen also denselben Zeitstempel.
 */
export class AgentRollouts1794182400000 implements MigrationInterface {
  name = 'AgentRollouts1794182400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_rollouts" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "target_version"    text NOT NULL,
        "scope"             text NOT NULL CHECK ("scope" IN ('outdated', 'selected', 'unknown')),
        "requested_devices" int,
        "skipped"           int NOT NULL DEFAULT 0,
        "created_by"        text,
        "created_at"        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_agent_rollouts_created" ON "agent_rollouts" ("created_at" DESC)`,
    );

    await queryRunner.query(`ALTER TABLE "agent_update_jobs" ADD COLUMN "rollout_id" uuid`);

    // Die Gruppen-CTE enthaelt eine fluechtige Funktion und wird deshalb genau
    // einmal ausgewertet — beide Verwendungen sehen dieselben IDs.
    await queryRunner.query(`
      WITH groups AS (
        SELECT gen_random_uuid() AS rollout_id, target_version, created_at
          FROM agent_update_jobs
         GROUP BY target_version, created_at
      ),
      inserted AS (
        INSERT INTO agent_rollouts (id, target_version, scope, created_at)
        SELECT rollout_id, target_version, 'unknown', created_at FROM groups
        RETURNING id
      )
      UPDATE agent_update_jobs j
         SET rollout_id = g.rollout_id
        FROM groups g
       WHERE g.target_version = j.target_version AND g.created_at = j.created_at
    `);

    await queryRunner.query(`ALTER TABLE "agent_update_jobs" ALTER COLUMN "rollout_id" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "agent_update_jobs"
         ADD CONSTRAINT "fk_agent_update_jobs_rollout"
         FOREIGN KEY ("rollout_id") REFERENCES "agent_rollouts" ("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agent_update_jobs_rollout" ON "agent_update_jobs" ("rollout_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_update_jobs" DROP COLUMN IF EXISTS "rollout_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_rollouts"`);
  }
}
