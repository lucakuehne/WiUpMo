import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Der letzte Neustart, wie der Agent ihn meldet.
 *
 * Am Geraet, nicht je Check-in, wie der zuletzt angemeldete Benutzer: Gefragt
 * ist der aktuelle Stand. Gemessen wird ueber die Laufzeit seit dem Start, die
 * Schlaf- und Ruhezustand einschliesst — ein Schnellstart beim Hochfahren
 * zaehlt deshalb nicht als Neustart, genau wie fuer Windows Update. Nur von
 * Geraeten mit Agent ab 0.8.0.
 */
export class LastBootAt1793750400000 implements MigrationInterface {
  name = 'LastBootAt1793750400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_boot_at" timestamptz`);
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."last_boot_at" IS ` +
        `'Letzter Neustart laut Agent (Laufzeit seit dem Systemstart, Schlafzeit eingeschlossen).'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "last_boot_at"`);
  }
}
