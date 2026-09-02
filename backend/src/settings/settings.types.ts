/**
 * Laufzeitkonfiguration. Sie liegt in der `settings`-Tabelle und ist im
 * Frontend aenderbar — anders als alles, was schon zum Startzeitpunkt
 * feststehen muss (Datenbankzugang, Enrollment-Token, Sitzungsgeheimnis).
 */

export const SETTING_KEYS = {
  ad: 'ad',
  thresholds: 'thresholds',
  retention: 'retention',
} as const;

export interface AdSettings {
  /** z. B. `ldaps://dc01.firma.local:636`. */
  url: string;

  /** Suchwurzel, z. B. `OU=Computer,DC=firma,DC=local`. */
  baseDn: string;

  bindDn: string;

  /**
   * Wird nie ueber die API ausgeliefert. Beim Speichern bedeutet ein leeres
   * Feld "unveraendert lassen" — sonst muesste das Passwort bei jeder
   * Aenderung an einem anderen Feld erneut eingegeben werden.
   */
  bindPassword: string;

  filter: string;

  /** AD liefert ohne Paging hoechstens 1000 Eintraege. */
  pageSize: number;

  intervalMinutes: number;

  /** Wartezeit nach dem Start bis zum ersten Abgleich. */
  startupDelaySeconds: number;

  /** `false` akzeptiert ein selbstsigniertes Zertifikat des Domaenencontrollers. */
  tlsRejectUnauthorized: boolean;

  timeoutSeconds: number;
}

export interface ThresholdSettings {
  /** Ab wann ein Geraet als "meldet sich nicht mehr" gilt. */
  staleAgentDays: number;

  /** Ab wann ein offenes sicherheitsrelevantes Update als kritisch gilt. */
  criticalOpenDays: number;

  /** Ab wann ein ausstehender Neustart auffaellig wird. */
  pendingRebootDays: number;
}

export interface RetentionSettings {
  /** Aufbewahrung der Zeitreihe `device_update_events`. */
  eventDays: number;

  /** Aufbewahrung der Check-in-Historie. */
  checkinDays: number;
}

export const DEFAULT_AD: AdSettings = {
  url: '',
  baseDn: '',
  bindDn: '',
  bindPassword: '',
  filter: '(objectClass=computer)',
  pageSize: 500,
  intervalMinutes: 360,
  startupDelaySeconds: 60,
  tlsRejectUnauthorized: true,
  timeoutSeconds: 60,
};

export const DEFAULT_THRESHOLDS: ThresholdSettings = {
  staleAgentDays: 14,
  criticalOpenDays: 30,
  pendingRebootDays: 7,
};

export const DEFAULT_RETENTION: RetentionSettings = {
  eventDays: 90,
  checkinDays: 90,
};

/** Ohne Server und Suchwurzel ist nichts abzugleichen. */
export function isAdConfigured(ad: AdSettings): boolean {
  return ad.url.trim() !== '' && ad.baseDn.trim() !== '';
}
