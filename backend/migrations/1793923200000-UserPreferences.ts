import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Was sich ein Benutzer in der Oberflaeche zuletzt ausgewaehlt hat — zuerst
 * Zeitraum und Intervall des Dashboards.
 *
 * Nach Benutzername statt als Spalte an `users`: Wer sich ueber LDAP anmeldet,
 * hat dort keine Zeile. Der Name steht kleingeschrieben, weil das Verzeichnis
 * Gross- und Kleinschreibung bei der Anmeldung nicht unterscheidet.
 */
export class UserPreferences1793923200000 implements MigrationInterface {
  name = 'UserPreferences1793923200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_preferences" (
        "username"    text PRIMARY KEY,
        "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_preferences"`);
  }
}
