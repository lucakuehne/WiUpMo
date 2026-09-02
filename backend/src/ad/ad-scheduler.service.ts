import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AdSyncTrigger } from '../database/enums.js';
import { SettingsService } from '../settings/settings.service.js';
import { isAdConfigured } from '../settings/settings.types.js';
import { AdSyncService } from './ad-sync.service.js';

const INTERVAL_NAME = 'ad-sync';
const STARTUP_TIMEOUT_NAME = 'ad-sync-startup';

/**
 * Meldet den wiederkehrenden Abgleich an.
 *
 * Ueber die SchedulerRegistry statt ueber den `@Interval`-Dekorator, weil das
 * Intervall aus den Einstellungen kommt — der Dekorator braucht einen zur
 * Uebersetzungszeit bekannten Wert. Und weil sich das Intervall im Frontend
 * aendern laesst, muss der Zeitgeber neu gesetzt werden koennen.
 */
@Injectable()
export class AdSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdSchedulerService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly sync: AdSyncService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    // Aenderungen an den Einstellungen setzen den Zeitgeber neu — sonst liefe
    // bis zum naechsten Neustart weiter das alte Intervall, und wer es im
    // Frontend aendert, saehe keine Wirkung.
    this.settings.onChanged(() => {
      void this.reschedule();
    });

    await this.scheduleStartupRun();
    await this.reschedule();
  }

  onModuleDestroy(): void {
    this.clear(INTERVAL_NAME, () => this.scheduler.deleteInterval(INTERVAL_NAME));
    this.clear(STARTUP_TIMEOUT_NAME, () => this.scheduler.deleteTimeout(STARTUP_TIMEOUT_NAME));
  }

  private async scheduleStartupRun(): Promise<void> {
    const config = await this.settings.getAd();
    if (!isAdConfigured(config)) {
      return;
    }

    // Nicht sofort beim Start: Migrationen, Datenbankverbindung und der erste
    // Ansturm des Hochlaufs sollen erst durch sein.
    const timeout = setTimeout(() => {
      void this.run();
    }, config.startupDelaySeconds * 1000);

    this.scheduler.addTimeout(STARTUP_TIMEOUT_NAME, timeout);
  }

  private async reschedule(): Promise<void> {
    this.clear(INTERVAL_NAME, () => this.scheduler.deleteInterval(INTERVAL_NAME));

    const config = await this.settings.getAd();
    if (!isAdConfigured(config)) {
      this.logger.log('AD-Abgleich ist nicht konfiguriert und bleibt aus.');
      return;
    }

    const interval = setInterval(
      () => {
        void this.run();
      },
      config.intervalMinutes * 60_000,
    );

    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `AD-Abgleich alle ${config.intervalMinutes} Minuten gegen ${config.url} (${config.baseDn}).`,
    );
  }

  private clear(name: string, remove: () => void): void {
    try {
      remove();
    } catch {
      // War nicht angemeldet. Kein Fehler — beim ersten Aufruf ist das der
      // Normalfall.
      void name;
    }
  }

  /**
   * Ein geplanter Lauf darf nie durchschlagen: Ein nicht erreichbarer
   * Domaenencontroller ist ein Betriebszustand, kein Grund, den Prozess mit
   * einer unbehandelten Ausnahme zu beenden. Das Ergebnis steht im Protokoll.
   */
  private async run(): Promise<void> {
    try {
      await this.sync.sync(AdSyncTrigger.Scheduled);
    } catch (error) {
      this.logger.warn(
        `Geplanter AD-Abgleich uebersprungen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
