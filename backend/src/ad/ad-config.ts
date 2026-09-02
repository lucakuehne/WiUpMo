import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Die AD-Anbindung wird ueber Umgebungsvariablen konfiguriert, nicht ueber die
 * `settings`-Tabelle.
 *
 * Der Entwicklungsplan sieht die Einstellungsseite erst fuer Phase 7 vor —
 * bis dahin waere eine Konfiguration in der Datenbank schlicht nicht
 * erreichbar. Dazu kommt das Bind-Passwort: Geheimnisse liegen in diesem
 * Projekt in der Umgebung, nicht in der Datenbank. Phase 7 kann die uebrigen
 * Felder in die Einstellungen ueberfuehren und diese Werte als Vorgabe nehmen.
 */
export interface AdConfig {
  enabled: boolean;

  /** z. B. `ldaps://dc01.firma.local:636` oder `ldap://dc01.firma.local:389`. */
  url: string;

  bindDn: string;
  bindPassword: string;

  /** Suchwurzel, z. B. `OU=Computer,DC=firma,DC=local`. */
  baseDn: string;

  /**
   * Standard laut Entwicklungsplan. Deaktivierte Computerkonten lassen sich
   * ausschliessen mit:
   * `(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))`
   */
  filter: string;

  /** Seitengroesse der LDAP-Suche. AD liefert ohne Paging hoechstens 1000 Eintraege. */
  pageSize: number;

  intervalMinutes: number;

  /** Wartezeit nach dem Start bis zum ersten Abgleich. */
  startupDelaySeconds: number;

  /** `false` akzeptiert ein selbstsigniertes Zertifikat des Domaenencontrollers. */
  tlsRejectUnauthorized: boolean;

  timeoutSeconds: number;
}

@Injectable()
export class AdConfigService {
  readonly config: AdConfig;

  constructor(config: ConfigService) {
    const url = config.get<string>('AD_URL') ?? '';
    const baseDn = config.get<string>('AD_BASE_DN') ?? '';

    this.config = {
      // Ohne Server und Suchwurzel ist nichts einzurichten — dann bleibt der
      // Abgleich stumm statt bei jedem Intervall einen Fehler zu protokollieren.
      enabled: url !== '' && baseDn !== '',
      url,
      baseDn,
      bindDn: config.get<string>('AD_BIND_DN') ?? '',
      bindPassword: config.get<string>('AD_BIND_PASSWORD') ?? '',
      filter: config.get<string>('AD_FILTER') ?? '(objectClass=computer)',
      pageSize: Number(config.get<string>('AD_PAGE_SIZE') ?? 500),
      intervalMinutes: Number(config.get<string>('AD_SYNC_INTERVAL_MINUTES') ?? 360),
      startupDelaySeconds: Number(config.get<string>('AD_STARTUP_DELAY_SECONDS') ?? 60),
      tlsRejectUnauthorized: config.get<string>('AD_TLS_REJECT_UNAUTHORIZED') !== 'false',
      timeoutSeconds: Number(config.get<string>('AD_TIMEOUT_SECONDS') ?? 60),
    };
  }

  /** Fuer die Anzeige im Frontend — ohne das Bind-Passwort. */
  get summary(): Omit<AdConfig, 'bindPassword'> & { bindPasswordSet: boolean } {
    const { bindPassword, ...rest } = this.config;
    return { ...rest, bindPasswordSet: bindPassword !== '' };
  }
}
