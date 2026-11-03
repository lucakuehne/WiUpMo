import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Der zuletzt angemeldete Benutzer, wie der Agent ihn meldet.
 *
 * Am Geraet und nicht je Check-in: Gefragt ist, wer den Rechner zuletzt
 * benutzt hat, nicht wer wann. Das Verzeichnis kennt die Angabe nicht — am
 * Computerkonto steht kein Benutzer —, sie kommt deshalb nur von Geraeten mit
 * Agent ab 0.7.1.
 */
export class LastLogonUser1793664000000 implements MigrationInterface {
  name = 'LastLogonUser1793664000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_logon_user" text`);
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "last_logon_display_name" text`);
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."last_logon_user" IS ` +
        `'Zuletzt angemeldetes Konto laut Agent, etwa DOMAENE\\benutzer (Registry LogonUI\\LastLoggedOnUser).'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."last_logon_display_name" IS ` +
        `'Anzeigename des zuletzt angemeldeten Kontos (Registry LogonUI\\LastLoggedOnDisplayName).'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "last_logon_display_name"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "last_logon_user"`);
  }
}
