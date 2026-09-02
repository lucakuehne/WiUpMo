import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AdSyncTrigger } from '../database/enums.js';
import { AdConfigService } from './ad-config.js';
import { AdSyncService } from './ad-sync.service.js';

const INTERVAL_NAME = 'ad-sync';
const STARTUP_TIMEOUT_NAME = 'ad-sync-startup';

/**
 * Meldet den wiederkehrenden Abgleich an.
 *
 * Ueber die <see cref="SchedulerRegistry"/> statt ueber den `@Interval`-Dekorator,
 * weil das Intervall aus der Konfiguration kommt — der Dekorator braucht einen
 * zur Uebersetzungszeit bekannten Wert.
 */
@Injectable()
export class AdSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdSchedulerService.name);

  constructor(
    private readonly configService: AdConfigService,
    private readonly sync: AdSyncService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const config = this.configService.config;

    if (!config.enabled) {
      this.logger.log('AD-Abgleich ist nicht konfiguriert und bleibt aus.');
      return;
    }

    // Nicht sofort beim Start: Migrationen, Datenbankverbindung und der erste
    // Ansturm des Hochlaufs sollen erst durch sein.
    const startup = setTimeout(() => {
      void this.run();
    }, config.startupDelaySeconds * 1000);
    this.scheduler.addTimeout(STARTUP_TIMEOUT_NAME, startup);

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

  onModuleDestroy(): void {
    // Ohne das Abmelden liefe der Zeitgeber beim Herunterfahren weiter und
    // hielte den Prozess offen.
    for (const [name, remove] of [
      [INTERVAL_NAME, () => this.scheduler.deleteInterval(INTERVAL_NAME)],
      [STARTUP_TIMEOUT_NAME, () => this.scheduler.deleteTimeout(STARTUP_TIMEOUT_NAME)],
    ] as const) {
      try {
        remove();
      } catch {
        // War nie angemeldet, weil die Anbindung nicht konfiguriert ist.
        void name;
      }
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
