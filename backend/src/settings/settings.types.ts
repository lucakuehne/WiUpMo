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
}

/** Untergrenze, damit hier nicht versehentlich "test" landet. */
export const MIN_ENROLLMENT_TOKEN_LENGTH = 16;

export const DEFAULT_AGENT: AgentSettings = {
  enrollmentToken: '',
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
