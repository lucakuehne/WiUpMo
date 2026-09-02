import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../database/entities/index.js';
import {
  AdSettings,
  DEFAULT_AD,
  DEFAULT_RETENTION,
  DEFAULT_THRESHOLDS,
  RetentionSettings,
  SETTING_KEYS,
  ThresholdSettings,
} from './settings.types.js';

type Listener = () => void;

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  /**
   * Wer auf Aenderungen reagieren muss, meldet sich hier an — derzeit der
   * AD-Zeitgeber, der sein Intervall neu setzen muss.
   *
   * Ueber Rueckrufe statt ueber einen Verweis vom Einstellungsmodul auf das
   * AD-Modul: sonst haetten sich die beiden Module gegenseitig importiert.
   */
  private readonly listeners = new Set<Listener>();

  constructor(
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedAdFromEnvironment();
  }

  onChanged(listener: Listener): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- Lesen ---------------------------------------------------------------

  async getAd(): Promise<AdSettings> {
    return this.read(SETTING_KEYS.ad, DEFAULT_AD);
  }

  async getThresholds(): Promise<ThresholdSettings> {
    return this.read(SETTING_KEYS.thresholds, DEFAULT_THRESHOLDS);
  }

  async getRetention(): Promise<RetentionSettings> {
    return this.read(SETTING_KEYS.retention, DEFAULT_RETENTION);
  }

  /**
   * Bewusst ohne Zwischenspeicher. Die Werte werden pro Abgleich einmal
   * gelesen, nicht pro Anfrage — ein Cache waere hier nur eine weitere Stelle,
   * an der ein veralteter Stand haengenbleiben kann.
   */
  private async read<T extends object>(key: string, fallback: T): Promise<T> {
    const row = await this.settings.findOne({ where: { key } });

    if (!row || typeof row.value !== 'object' || row.value === null) {
      return { ...fallback };
    }

    // Die Vorgabewerte fuellen auf: So ergaenzt ein neues Feld in einer
    // spaeteren Version einen bestehenden Datensatz, ohne Migration.
    return { ...fallback, ...(row.value as Partial<T>) };
  }

  // --- Schreiben -----------------------------------------------------------

  async updateAd(patch: Partial<AdSettings>): Promise<AdSettings> {
    const current = await this.getAd();

    // Ein leeres Passwortfeld heisst "unveraendert", nicht "loeschen".
    const bindPassword =
      patch.bindPassword === undefined || patch.bindPassword === ''
        ? current.bindPassword
        : patch.bindPassword;

    const next: AdSettings = { ...current, ...patch, bindPassword };
    await this.write(SETTING_KEYS.ad, next, 'Anbindung an das Active Directory.');
    this.notify();
    return next;
  }

  async updateThresholds(patch: Partial<ThresholdSettings>): Promise<ThresholdSettings> {
    const next = { ...(await this.getThresholds()), ...patch };
    await this.write(SETTING_KEYS.thresholds, next, 'Schwellwerte fuer Auswertungen.');
    return next;
  }

  async updateRetention(patch: Partial<RetentionSettings>): Promise<RetentionSettings> {
    const next = { ...(await this.getRetention()), ...patch };
    await this.write(SETTING_KEYS.retention, next, 'Aufbewahrungsfristen.');
    return next;
  }

  private async write(key: string, value: object, description: string): Promise<void> {
    await this.settings.save({ key, value, description });
  }

  /**
   * Uebernimmt die AD-Variablen aus der Umgebung, solange in der Datenbank
   * noch nichts steht.
   *
   * Damit bleibt eine Installation, die bisher ueber `AD_*` konfiguriert war,
   * unveraendert lauffaehig. Sobald die Einstellungen einmal gespeichert
   * wurden, gilt die Datenbank — die Umgebungsvariablen sind ab dann nur noch
   * die Erstbefuellung und werden nicht mehr gelesen.
   */
  private async seedAdFromEnvironment(): Promise<void> {
    const existing = await this.settings.findOne({ where: { key: SETTING_KEYS.ad } });
    if (existing) {
      return;
    }

    const url = this.config.get<string>('AD_URL') ?? '';
    const baseDn = this.config.get<string>('AD_BASE_DN') ?? '';

    const seeded: AdSettings = {
      ...DEFAULT_AD,
      url,
      baseDn,
      bindDn: this.config.get<string>('AD_BIND_DN') ?? '',
      bindPassword: this.config.get<string>('AD_BIND_PASSWORD') ?? '',
      filter: this.config.get<string>('AD_FILTER') ?? DEFAULT_AD.filter,
      intervalMinutes: Number(
        this.config.get<string>('AD_SYNC_INTERVAL_MINUTES') ?? DEFAULT_AD.intervalMinutes,
      ),
      startupDelaySeconds: Number(
        this.config.get<string>('AD_STARTUP_DELAY_SECONDS') ?? DEFAULT_AD.startupDelaySeconds,
      ),
      tlsRejectUnauthorized: this.config.get<string>('AD_TLS_REJECT_UNAUTHORIZED') !== 'false',
    };

    await this.write(SETTING_KEYS.ad, seeded, 'Anbindung an das Active Directory.');

    if (url !== '' || baseDn !== '') {
      this.logger.log('AD-Einstellungen aus den Umgebungsvariablen uebernommen.');
    }
  }
}
