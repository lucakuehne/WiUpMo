/**
 * So beginnt die Warnung des Agents, wenn er das Backend nicht erreicht. Als
 * Stoerung zaehlt sie nicht: Der Check-in, der sie mitbringt, ist selbst
 * angekommen — wie in der Karte „Agent-Zustand" am Geraet.
 */
export const TRANSMISSION_FAILURE = 'Uebermittlung fehlgeschlagen';

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
