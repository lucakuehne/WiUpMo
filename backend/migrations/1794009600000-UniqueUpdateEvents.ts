import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ein Ereignis je Geraet, Update, Art und Zeitpunkt.
 *
 * Der Agent fragt die Historie ab dem Beginn des vorigen Durchlaufs ab, liest
 * sie aber erst nach der Update-Suche, die Minuten dauern kann. Was Windows
 * waehrend dieser Suche einspielt, steht deshalb in zwei aufeinanderfolgenden
 * Snapshots — und kam bisher zweimal in die Zeitreihe. Im Dashboard standen so
 * mehr Installationen, als es gab, und in der Geraeteansicht doppelte Versuche.
 *
 * Die vorhandenen Doppel werden entfernt, der aelteste Eintrag bleibt. Danach
 * verhindert der eindeutige Index weitere; der Check-in uebergeht sie.
 */
export class UniqueUpdateEvents1794009600000 implements MigrationInterface {
  name = 'UniqueUpdateEvents1794009600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM device_update_events
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  row_number() OVER (
                    PARTITION BY device_id, update_id, event_type, occurred_at ORDER BY id
                  ) AS nr
             FROM device_update_events
         ) numbered
         WHERE nr > 1
       )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_device_update_events_unique"
         ON "device_update_events" ("device_id", "update_id", "event_type", "occurred_at")`,
    );
  }

  /** Die entfernten Doppel kommen nicht zurueck; zurueckgenommen wird nur der Index. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_device_update_events_unique"`);
  }
}
