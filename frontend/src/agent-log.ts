import type { AgentLogEntry } from '@/api/types';

/**
 * So beginnt die Warnung des Agents, wenn er das Backend nicht erreicht
 * (AgentCycle.FlushAsync). Als Störung taugt sie nie: Der Check-in, der sie
 * mitbringt, ist selbst angekommen — die Verbindung steht also wieder.
 */
export const TRANSMISSION_FAILURE = 'Uebermittlung fehlgeschlagen';

/** So beginnt die Warnung, wenn der Agent Windows Update nicht lesen konnte. */
export const UPDATE_STATE_UNREADABLE = 'Update-Zustand nicht lesbar';

/** Der Agent sendet gleich nach dem Erfassen; so nah gehört eine Übermittlung zum selben Durchlauf. */
const SAME_CYCLE_MS = 120_000;

/**
 * Ob eine Warnung zur Update-Suche entstand, während das Gerät offline war:
 * Im selben Durchlauf scheiterte auch die Übermittlung ans Backend — weder
 * Firmennetz noch VPN. Dieselbe Regel wie im Backend (problem-key.ts), damit
 * Gerät und „Störungen“ dasselbe sagen.
 */
export function isOfflineEntry(entry: AgentLogEntry, entries: AgentLogEntry[]): boolean {
  if (!entry.message.startsWith(UPDATE_STATE_UNREADABLE)) return false;
  const at = new Date(entry.at).getTime();
  return entries.some((other) => {
    if (!other.message.startsWith(TRANSMISSION_FAILURE)) return false;
    const failed = new Date(other.at).getTime();
    return failed >= at && failed - at <= SAME_CYCLE_MS;
  });
}
