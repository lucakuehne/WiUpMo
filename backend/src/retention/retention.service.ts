import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service.js';

export interface RetentionResult {
  eventsDeleted: number;
  checkinsDeleted: number;
  eventDays: number;
  checkinDays: number;
}

/**
 * Loeschen in Stapeln statt in einem Rutsch.
 *
 * Ein einzelnes DELETE ueber Millionen Zeilen haelt eine Transaktion lange
 * offen, laesst das Write-Ahead-Log anwachsen und blockiert nebenher
 * eintreffende Check-ins. In Stapeln bleibt jede Transaktion kurz, und der
 * Job kann jederzeit unterbrochen werden, ohne etwas halb erledigt zu lassen.
 */
const BATCH_SIZE = 10_000;

/** Sicherung gegen eine Endlosschleife, falls ein Stapel nie leer wird. */
const MAX_BATCHES = 1_000;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Nachts um 03:15. Die krumme Minute ist Absicht: Zur vollen Stunde laufen
   * auf einem geteilten Host erfahrungsgemaess schon genug andere Jobs.
   */
  @Cron('15 3 * * *', { name: 'retention' })
  async scheduled(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.logger.error(
        `Aufraeumen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async run(): Promise<RetentionResult> {
    if (this.running) {
      throw new Error('Es laeuft bereits ein Aufraeumvorgang.');
    }

    this.running = true;

    try {
      const { eventDays, checkinDays } = await this.settings.getRetention();

      const eventsDeleted = await this.deleteInBatches(
        `DELETE FROM device_update_events
          WHERE id IN (
            SELECT id FROM device_update_events
             WHERE occurred_at < now() - make_interval(days => $1)
             LIMIT ${BATCH_SIZE}
          )
          RETURNING id`,
        eventDays,
      );

      const checkinsDeleted = await this.deleteInBatches(
        `DELETE FROM device_checkins
          WHERE id IN (
            SELECT id FROM device_checkins
             WHERE collected_at < now() - make_interval(days => $1)
             LIMIT ${BATCH_SIZE}
          )
          RETURNING id`,
        checkinDays,
      );

      if (eventsDeleted > 0 || checkinsDeleted > 0) {
        this.logger.log(
          `Aufgeraeumt: ${eventsDeleted} Ereignisse (aelter als ${eventDays} Tage), ` +
            `${checkinsDeleted} Check-ins (aelter als ${checkinDays} Tage). ` +
            'Die aktuellen Update-Zustaende bleiben unberuehrt.',
        );
      }

      return { eventsDeleted, checkinsDeleted, eventDays, checkinDays };
    } finally {
      this.running = false;
    }
  }

  /**
   * Die Abfragen tragen `RETURNING id`, damit die Anzahl aus der Laenge des
   * Ergebnisses kommt.
   *
   * `dataSource.query()` reicht bei einem DELETE ohne RETURNING nur ein leeres
   * Array durch — die Zeilenzahl waere immer 0 gewesen, die Schleife nach dem
   * ersten Stapel stehengeblieben und die Meldung falsch. Die zurueckgegebenen
   * Schluessel kosten wenig und sind der einzige treiberunabhaengige Weg an
   * die Zahl.
   */
  private async deleteInBatches(sql: string, days: number): Promise<number> {
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows: unknown[] = await this.dataSource.query(sql, [days]);
      total += rows.length;

      if (rows.length < BATCH_SIZE) {
        break;
      }
    }

    return total;
  }
}
