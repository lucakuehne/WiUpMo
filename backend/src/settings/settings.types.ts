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
  install: 'install',
  restart: 'restart',
} as const;

export type AuthProviderName = 'local' | 'ldap';

export interface AuthSettings {
  /**
   * Die Anmeldewege sind einzeln schaltbar und schliessen sich nicht aus.
   *
   * Das ersetzt die frueheren Felder `provider` und `allowLocalFallback`: Ein
   * "Weg plus Ausnahme" beschrieb denselben Sachverhalt umstaendlicher, und
   * die Ausnahme war in Wahrheit ein zweiter gleichwertiger Weg. Beim Anmelden
   * wird zuerst das Verzeichnis gefragt, danach die lokale Tabelle.
   */
  localEnabled: boolean;

  ldapEnabled: boolean;

  /**
   * Vorlage fuer den Bind-Namen, `{username}` wird ersetzt. Fuer ein Active
   * Directory sind zwei Formen gebraeuchlich:
   * `{username}@firma.local` (UPN) oder `FIRMA\{username}`.
   */
  userDnTemplate: string;

  /**
   * Gruppen, deren Mitglieder sich anmelden duerfen (DNs). Leer heisst: jedes
   * Konto, das sich am Verzeichnis anmelden kann, darf auch hier hinein.
   *
   * Die Pruefung schliesst verschachtelte Mitgliedschaften ein — wer nur ueber
   * eine untergeordnete Gruppe drinsteckt, kommt ebenfalls herein. Alles
   * andere waere in gewachsenen Verzeichnissen unbrauchbar, weil dort
   * Berechtigungen fast immer ueber Gruppenketten vergeben sind.
   */
  allowedGroups: string[];
}

export const DEFAULT_AUTH: AuthSettings = {
  localEnabled: true,
  ldapEnabled: false,
  userDnTemplate: '{username}',
  allowedGroups: [],
};

/** Die abgeloeste Form, wie sie in bestehenden Installationen gespeichert ist. */
interface LegacyAuthSettings {
  provider?: AuthProviderName;
  allowLocalFallback?: boolean;
}

/**
 * Uebersetzt eine gespeicherte Konfiguration in die aktuelle Form.
 *
 * Eine Migration in der Datenbank waere hier der schwerere Weg: Es geht um
 * einen einzigen jsonb-Wert, und die Umrechnung ist eindeutig. Beim naechsten
 * Speichern verschwindet die alte Form von selbst.
 */
export function migrateAuthSettings(raw: AuthSettings & LegacyAuthSettings): AuthSettings {
  const { localEnabled, ldapEnabled, userDnTemplate, allowedGroups } = raw;

  if (raw.provider === undefined) {
    return { localEnabled, ldapEnabled, userDnTemplate, allowedGroups };
  }

  return {
    ldapEnabled: raw.provider === 'ldap',
    // Im lokalen Betrieb war die lokale Anmeldung immer offen; im
    // LDAP-Betrieb entschied der Rueckfallschalter, der standardmaessig an war.
    localEnabled: raw.provider === 'local' || raw.allowLocalFallback !== false,
    userDnTemplate,
    allowedGroups,
  };
}

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

  /**
   * Abstand zwischen zwei regulaeren Durchlaeufen eines Agents, in Minuten.
   *
   * Der Agent bringt denselben Wert als eigene Einstellung mit; der hier
   * gesetzte geht bei jedem Check-in mit und hat Vorrang. Anders liesse sich
   * der Takt einer Flotte nur ueber eine erneute Verteilung der
   * `appsettings.json` aendern.
   *
   * Wirksam wird eine Aenderung erst beim naechsten Check-in — bei einer
   * Verlaengerung also nach dem bisherigen Takt, bei einer Verkuerzung
   * ebenfalls. Sofort umschalten liesse sich nur mit einer Gegenrichtung, die
   * es hier bewusst nicht gibt: Der Agent spricht das Backend an, nie
   * umgekehrt.
   */
  checkIntervalMinutes: number;
}

/** Untergrenze, damit hier nicht versehentlich "test" landet. */
export const MIN_ENROLLMENT_TOKEN_LENGTH = 16;

/**
 * Grenzen des Melde-Intervalls, in Minuten.
 *
 * Nach unten zwei Minuten: Jeder Durchlauf enthaelt eine vollstaendige
 * Update-Suche bei WSUS bzw. Microsoft Update. Der Agent wartet zwar das Ende
 * eines Durchlaufs ab, bevor er den naechsten ansetzt — enger getaktet waere er
 * aber dauernd beschaeftigt, und die Update-Quelle bekaeme die Anfragen der
 * ganzen Flotte im Minutentakt. Nach oben sechs Stunden; laenger, und die
 * Auswertungen beschreiben einen Zustand, den es so nicht mehr gibt.
 */
export const MIN_CHECK_INTERVAL_MINUTES = 2;
export const MAX_CHECK_INTERVAL_MINUTES = 360;

/**
 * Agents vor 0.8.1 nehmen nichts unter fuenf Minuten an. Sie blieben bei fuenf
 * und schrieben bei jedem Check-in eine Warnung, die dann als Stoerung am
 * Geraet stuende — sie bekommen deshalb hoechstens ihre eigene Untergrenze.
 */
export const SHORT_INTERVAL_AGENT_VERSION = '0.8.1';
export const LEGACY_MIN_CHECK_INTERVAL_MINUTES = 5;

/**
 * 5 Minuten wie die eigene Vorgabe des Agents: So steht ein Geraet, das einen
 * Neustart hinter sich oder ein Update installiert hat, nach wenigen Minuten
 * richtig in der Oberflaeche.
 *
 * Gilt nur, solange in der Datenbank nichts gespeichert ist. Eine bestehende
 * Installation behaelt ihren Wert, bis er unter Einstellungen geaendert wird.
 */
export const DEFAULT_AGENT: AgentSettings = {
  enrollmentToken: '',
  checkIntervalMinutes: 5,
};

export interface AdSettings {
  /** z. B. `ldaps://dc01.firma.local:636`. */
  url: string;

  /**
   * Wurzel der Domaene, z. B. `DC=firma,DC=local`. Sie dient dem Durchsuchen
   * des Verzeichnisses und als Rueckfallwert, wenn keine Gruppen gewaehlt sind.
   */
  baseDn: string;

  /**
   * Die tatsaechlich abgeglichenen Bereiche, jeweils ueber den gesamten
   * Unterbaum. Leer bedeutet: die ganze Domaene.
   *
   * Mehrere Bereiche, weil Computerkonten selten an einer Stelle liegen —
   * typisch sind getrennte Einheiten fuer Notebooks, Arbeitsplaetze und
   * Standorte. Eine einzelne Suchwurzel zwaenge dazu, entweder die halbe
   * Domaene mitzunehmen oder den Filter zu verbiegen.
   */
  searchBases: string[];

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

  /**
   * Zertifikat der ausstellenden Stelle im PEM-Format, sofern der
   * Domaenencontroller ein Zertifikat aus einer internen PKI verwendet.
   *
   * Der bessere Weg als das Abschalten der Pruefung: Die Gegenstelle wird
   * weiterhin geprueft, nur eben gegen diese Stelle statt gegen die
   * oeffentlichen Wurzelzertifikate. Ein untergeschobener Server faellt damit
   * weiterhin auf.
   */
  caCertificate: string;

  /**
   * `false` schaltet die Pruefung der Gegenstelle ab. Nur sinnvoll, wenn kein
   * Zertifikat der ausstellenden Stelle vorliegt — dann ist die Verbindung
   * zwar verschluesselt, aber nicht mehr gegen einen untergeschobenen Server
   * geschuetzt.
   */
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
  searchBases: [],
  caCertificate: '',
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

export interface InstallSettings {
  /**
   * Tage nach dem gewaehlten Zeitpunkt, bis ein nicht abgeholter
   * Installationsauftrag ablaeuft. Ein Laptop, der wochenlang nicht im Netz
   * war, soll nicht unerwartet mit einer alten Anweisung loslegen.
   */
  expiryDays: number;
}

export const MIN_INSTALL_EXPIRY_DAYS = 1;
export const MAX_INSTALL_EXPIRY_DAYS = 90;

export const DEFAULT_INSTALL: InstallSettings = {
  expiryDays: 14,
};

/**
 * Wie ein angeforderter Neustart beim angemeldeten Benutzer ablaeuft.
 *
 * Die Werte gehen beim Anlegen mit in den Auftrag: Eine spaetere Aenderung
 * gilt fuer neue Auftraege, ein laufender behaelt seine Regeln.
 */
export interface RestartSettings {
  /** Wahlmoeglichkeiten zum Verschieben, in Minuten. */
  deferralMinutes: number[];

  /** „Bis morgen um … Uhr" als weitere Wahl; null blendet sie aus. */
  nextMorningHour: number | null;

  /** So oft darf der Benutzer verschieben. */
  maxDeferrals: number;

  /** Spaetestens so viele Stunden nach der ersten Meldung wird neu gestartet. */
  deadlineHours: number;

  /** Der letzte Countdown, nicht mehr verschiebbar, in Minuten. */
  countdownMinutes: number;

  /**
   * Der Text der Meldung zwischen Ueberschrift und Frist, mit Platzhaltern
   * (siehe {@link RESTART_PROMPT_PLACEHOLDERS}). Eine Zeile, deren Platzhalter
   * alle leer bleiben, faellt weg — so verschwindet „Grund: {grund}" ohne Grund.
   */
  promptText: string;

  /** Tage, bis ein nicht abgeholter Auftrag verfaellt. */
  expiryDays: number;
}

export const RESTART_LIMITS = {
  deferralMinutes: { min: 5, max: 1440, maxOptions: 6 },
  maxDeferrals: { min: 0, max: 10 },
  deadlineHours: { min: 1, max: 168 },
  countdownMinutes: { min: 1, max: 60 },
  promptTextLength: 1000,
  expiryDays: { min: 1, max: 30 },
} as const;

/**
 * Wie geplant: verschieben um eine oder vier Stunden oder bis zum naechsten
 * Morgen, hoechstens dreimal, spaetestens einen Tag nach der ersten Meldung.
 */
export const DEFAULT_RESTART: RestartSettings = {
  deferralMinutes: [60, 240],
  nextMorningHour: 8,
  maxDeferrals: 3,
  deadlineHours: 24,
  countdownMinutes: 10,
  promptText: 'Grund: {grund}',
  expiryDays: 7,
};

/** Was der Agent ab 0.9.1 im Text der Meldung ersetzt. */
export const RESTART_PROMPT_PLACEHOLDERS = ['grund', 'frist', 'verschiebungen', 'computer', 'benutzer'] as const;

/**
 * Bis 0.9.0 gab es statt des Textes nur einen Zusatz unter dem Grund. Ein so
 * gespeicherter Zusatz wandert einmalig unter die Zeile mit dem Grund.
 */
export function promptTextFrom(settings: { promptText?: string; message?: string }): string {
  if (settings.promptText !== undefined) return settings.promptText;
  const message = settings.message?.trim();
  return message ? `${DEFAULT_RESTART.promptText}\n\n${message}` : DEFAULT_RESTART.promptText;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  eventDays: 90,
  checkinDays: 90,
};

/** Ohne Server und Suchwurzel ist nichts abzugleichen. */
export function isAdConfigured(ad: AdSettings): boolean {
  return ad.url.trim() !== '' && effectiveSearchBases(ad).length > 0;
}

/**
 * Die Bereiche, ueber die tatsaechlich gesucht wird.
 *
 * Untergeordnete Auswahlen werden verworfen: Wer `OU=Clients` und darin
 * `OU=Notebooks` ankreuzt, meint einmal alles unterhalb von Clients. Die Suche
 * laeuft ohnehin ueber den gesamten Unterbaum — die zweite Angabe braeuchte
 * nur einen weiteren Durchlauf, um dieselben Konten noch einmal zu lesen.
 */
export function effectiveSearchBases(ad: AdSettings): string[] {
  const selected = ad.searchBases.map((base) => base.trim()).filter((base) => base !== '');

  if (selected.length === 0) {
    return ad.baseDn.trim() !== '' ? [ad.baseDn.trim()] : [];
  }

  return selected.filter(
    (candidate) =>
      !selected.some(
        (other) => other !== candidate && candidate.toLowerCase().endsWith(`,${other.toLowerCase()}`),
      ),
  );
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
