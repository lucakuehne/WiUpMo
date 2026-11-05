import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entfernt Store-Apps aus dem Katalog — samt Zustaenden und Ereignissen, die
 * ueber den Fremdschluessel mitgehen.
 *
 * Der Check-in uebergeht sie kuenftig (siehe `src/common/store-apps.ts`); was
 * bis dahin aus der Windows-Update-Historie hereinkam, raeumt diese Migration
 * weg. Das Muster steht hier ein zweites Mal, damit die Migration auch dann
 * dasselbe tut, wenn sich die Erkennung spaeter aendert.
 */
export class RemoveStoreApps1794096000000 implements MigrationInterface {
  name = 'RemoveStoreApps1794096000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM updates WHERE title ~ '^(9[0-9A-Z]{11}|XP[0-9A-Z]{12})-[^ ]'`);
  }

  /** Was entfernt ist, kommt nicht zurueck; der Agent meldet seine Historie nur einmal. */
  public async down(): Promise<void> {
    // absichtlich leer
  }
}
