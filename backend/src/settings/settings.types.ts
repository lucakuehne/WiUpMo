/**
 * Laufzeitkonfiguration. Sie liegt in der `settings`-Tabelle und ist im
 * Frontend aenderbar — anders als alles, was schon zum Startzeitpunkt
 * feststehen muss (Datenbankzugang, Enrollment-Token, Sitzungsgeheimnis).
 */

export const SETTING_KEYS = {
  agent: 'agent',
  ad: 'ad',
  auth: 'auth',
  thresholds: 'thresholds',
  retention: 'retention',
} as const;

export type AuthProviderName = 'local' | 'ldap';

export interface AuthSettings {
  provider: AuthProviderName;

  /**
   * Vorlage fuer den Bind-Namen, `{username}` wird ersetzt. Fuer ein Active
   * Directory sind zwei Formen gebraeuchlich:
   * `{username}@firma.local` (UPN) oder `FIRMA\{username}`.
   */
  userDnTemplate: string;

  /**
   * Laesst lokale Benutzer auch im LDAP-Betrieb herein.
   *
   * Standardmaessig an, und das ist wichtig: Ohne diesen Weg sperrt ein
   * ausgefallener Domaenencontroller oder eine falsch gesetzte Vorlage jeden
   * aus dem System aus — ausgerechnet in dem Moment, in dem man hineinsehen
   * moechte.
   */
  allowLocalFallback: boolean;
}

export const DEFAULT_AUTH: AuthSettings = {
  provider: 'local',
  userDnTemplate: '{username}',
  allowLocalFallback: true,
};

export interface AgentSettings {
  /**
   * Gemeinsames Geheimnis, mit dem sich ein Agent einmalig registriert.
   *
   * Anders als das AD-Bindepasswort wird es ueber die API ausgeliefert — man
   * braucht es bei jeder Agent-Installation, und es aus der Datenbank
   * abzuschreiben waere der schlechtere Weg. Es oeffnet auch nichts weiter:
   * Damit laesst sich ein Geraet anmelden, nicht auf Daten zugreifen. Jedes
   * registrierte Geraet arbeitet danach mit einem eigenen Secret.
   */
  enrollmentToken: string;
}

/** Untergrenze, damit hier nicht versehentlich "test" landet. */
export const MIN_ENROLLMENT_TOKEN_LENGTH = 16;

export const DEFAULT_AGENT: AgentSettings = {
  enrollmentToken: '',
};

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

  /**
   * `guided` setzt den Filter aus den Ankreuzfeldern zusammen, `custom`
   * benutzt <see cref="filter"/> unveraendert. Der geführte Weg ist der
   * Normalfall — die LDAP-Filtersyntax ist fehleranfaellig, und der Ausdruck
   * fuer "nicht deaktiviert" merkt sich niemand.
   */
  filterMode: 'guided' | 'custom';

  /** Nur im gefuehrten Modus. */
  excludeDisabled: boolean;

  /**
   * Blendet Serverbetriebssysteme aus. Der Scope der Loesung sind Laptops und
   * Arbeitsplatzrechner; Server wuerden die Auswertungen verzerren.
   */
  excludeServers: boolean;

  /** Im gefuehrten Modus der zusammengesetzte Ausdruck, sonst der eigene. */
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
  filterMode: 'guided',
  excludeDisabled: true,
  excludeServers: false,
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

/**
 * Der tatsaechlich verwendete LDAP-Filter.
 *
 * Im gefuehrten Modus wird er aus den Ankreuzfeldern gebaut, damit niemand die
 * Bitmasken-Syntax fuer `userAccountControl` von Hand schreiben muss — ein
 * verirrtes Zeichen darin liefert keinen Fehler, sondern still zu wenige oder
 * zu viele Konten.
 */
export function effectiveAdFilter(ad: AdSettings): string {
  if (ad.filterMode === 'custom') {
    return ad.filter.trim() || '(objectClass=computer)';
  }

  const clauses = ['(objectClass=computer)'];

  if (ad.excludeDisabled) {
    // Bit 2 (ACCOUNTDISABLE) in userAccountControl, ueber den
    // LDAP_MATCHING_RULE_BIT_AND-Vergleich.
    clauses.push('(!(userAccountControl:1.2.840.113556.1.4.803:=2))');
  }

  if (ad.excludeServers) {
    clauses.push('(!(operatingSystem=*Server*))');
  }

  return clauses.length === 1 ? clauses[0] : `(&${clauses.join('')})`;
}
