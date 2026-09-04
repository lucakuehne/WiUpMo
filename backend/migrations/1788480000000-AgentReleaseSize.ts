import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ergaenzt die Groesse des Agent-Binaries.
 *
 * Sie liesse sich beim Anzeigen auch von der Platte lesen, aber dann waere die
 * Liste der Releases von Dateizugriffen abhaengig — und bei einem
 * Datenbankeintrag ohne Datei (neu angelegtes Volume) haette man statt einer
 * Zahl einen Fehler. Der Wert wird beim Hochladen einmal ermittelt.
 */
export class AgentReleaseSize1788480000000 implements MigrationInterface {
  name = 'AgentReleaseSize1788480000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_releases" ADD COLUMN "size_bytes" bigint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "agent_releases"."size_bytes" IS 'Groesse des Binaries in Bytes, beim Hochladen ermittelt.'`,
    );

    // Ein Index auf den Auftragszustand: Bei jedem Check-in wird nach offenen
    // Auftraegen des Geraets gesucht. Ohne ihn ist das bei wachsender
    // Auftragshistorie ein vollstaendiger Tabellendurchlauf pro Check-in.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_update_jobs_open"
        ON "agent_update_jobs" ("device_id", "created_at")
        WHERE "state" IN ('pending', 'delivered')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_update_jobs_open"`);
    await queryRunner.query(`ALTER TABLE "agent_releases" DROP COLUMN IF EXISTS "size_bytes"`);
  }
}
