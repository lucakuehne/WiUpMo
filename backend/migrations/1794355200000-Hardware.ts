import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nimmt die Hardware-Angaben des Agents auf (ab 0.10.0).
 *
 * Wie die Selbstauskunft als eine jsonb-Spalte am Geraet: Es zaehlt der
 * jeweils letzte Stand, gelesen wird er am Stueck auf der Geraeteseite, und
 * neue Angaben kosten so keine Migration. Dazu der Zeitpunkt, zu dem der Agent
 * sie zuletzt geschickt hat — er schickt sie nur bei Aenderung und einmal am
 * Tag, nicht mit jedem Check-in.
 */
export class Hardware1794355200000 implements MigrationInterface {
  name = 'Hardware1794355200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "hardware" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "hardware_reported_at" timestamptz`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."hardware" IS ` +
        `'Letzte Hardware-Angaben des Agents: Modell, Prozessor, Speicher, Datentraeger, TPM, Secure Boot, BitLocker, Komponenten.'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "hardware_reported_at"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "hardware"`);
  }
}
