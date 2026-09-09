import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nimmt den Selbstauskunftsbericht des Agents auf.
 *
 * Als eine jsonb-Spalte am Geraet, nicht als eigene Tabelle: Es ist der jeweils
 * letzte Stand, keine Zeitreihe — die Vorgaenger interessieren nicht, und eine
 * Historie brauchte eine eigene Aufbewahrungsfrist. Einzelne Spalten waeren die
 * dritte Moeglichkeit; sie kosten bei jeder Erweiterung eine Migration, und der
 * Inhalt wird ausschliesslich am Stueck gelesen und geschrieben.
 */
export class AgentDiagnostics1789200000000 implements MigrationInterface {
  name = 'AgentDiagnostics1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `IF NOT EXISTS`, weil die Spalte auf einem Stand, der die Migration nicht
    // ausgefuehrt hat, von Hand nachgetragen worden sein kann — dann soll der
    // regulaere Lauf sie nur noch verbuchen und nicht abbrechen.
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "agent_diagnostics" jsonb`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."agent_diagnostics" IS ` +
        `'Letzter Selbstauskunftsbericht des Agents: Warteschlange, laufendes Selbst-Update, Updater-Task, letzte Stoerung.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "agent_diagnostics"`);
  }
}
