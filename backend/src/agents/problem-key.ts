/**
 * So beginnt die Warnung des Agents, wenn er das Backend nicht erreicht. Als
 * Stoerung zaehlt sie nicht: Der Check-in, der sie mitbringt, ist selbst
 * angekommen — wie in der Karte „Agent-Zustand" am Geraet.
 */
export const TRANSMISSION_FAILURE = 'Uebermittlung fehlgeschlagen';

/** So beginnt die Warnung, wenn der Agent Windows Update nicht lesen konnte. */
export const UPDATE_STATE_UNREADABLE = 'Update-Zustand nicht lesbar';

/**
 * Innerhalb dieser Spanne nach der Warnung zur Update-Suche gehoert eine
 * gescheiterte Uebermittlung zum selben Durchlauf: Der Agent sendet gleich
 * nach dem Erfassen.
 */
const SAME_CYCLE_MS = 120_000;

/**
 * Ob eine Warnung zur Update-Suche entstand, waehrend das Geraet offline war —
 * weder im Firmennetz noch im VPN.
 *
 * Erkennbar daran, dass im selben Durchlauf auch das Backend nicht erreichbar
 * war. Dann ist es keine Stoerung, sondern der Normalfall eines Notebooks
 * unterwegs: Ohne Netz erreicht es weder WSUS noch das Backend. Eine echte
 * Stoerung bleibt die Warnung, wenn das Backend erreichbar war, WSUS aber
 * nicht — etwa weil eine Firewall im VPN den Weg dorthin sperrt.
 *
 * `transmissionFailures` sind die Zeitpunkte der gescheiterten Uebermittlungen
 * desselben Geraets, in Millisekunden.
 */
export function isOfflineUpdateWarning(message: string, at: number, transmissionFailures: number[]): boolean {
  return (
    message.startsWith(UPDATE_STATE_UNREADABLE) &&
    transmissionFailures.some((failure) => failure >= at && failure - at <= SAME_CYCLE_MS)
  );
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CODE_OR_NUMBER = /0x[0-9a-f]+|\d+(?:[.,:]\d+)*/gi;

/**
 * Der Schluessel, unter dem gleichartige Meldungen zusammenfallen.
 *
 * Der Agent schickt den fertigen Text, nicht die Vorlage dahinter. Zahlen —
 * Anzahlen, Uhrzeiten, Ports, Versionen — und GUIDs werden deshalb ersetzt;
 * Fehlercodes in der Form 0x… bleiben, sie unterscheiden die Stoerung.
 */
export function problemKey(message: string): string {
  return message
    .replace(GUID, '…')
    .replace(CODE_OR_NUMBER, (token) => (/^0x/i.test(token) ? `0x${token.slice(2).toUpperCase()}` : '#'))
    .replace(/\s+/g, ' ')
    .trim();
}
