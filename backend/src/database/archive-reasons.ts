/**
 * Die Gruende, aus denen der AD-Abgleich ein Geraet archiviert.
 *
 * Sie stehen hier und nicht im Abgleich selbst, weil auch die Registrierung sie
 * kennen muss: Ein Geraet, das aus dem abgeglichenen Bereich gefallen ist, darf
 * sich nicht dadurch selbst reaktivieren, dass sein Agent sich neu anmeldet.
 * Sonst heben sich Abgleich und Agent gegenseitig auf.
 *
 * Ein eigenes Feld waere sauberer als der Vergleich einer Zeichenkette. Es
 * braeuchte aber eine Migration fuer eine Unterscheidung, die es an genau zwei
 * Stellen gibt — das steht in keinem Verhaeltnis, solange die Werte hier
 * beisammen liegen.
 */
export const ARCHIVE_REASON_GONE = 'Im Active Directory nicht mehr vorhanden.';

export const ARCHIVE_REASON_OUT_OF_SCOPE =
  'Liegt nicht mehr in den abgeglichenen Bereichen des Verzeichnisses.';

export function isAdArchiveReason(reason: string | null): boolean {
  return reason === ARCHIVE_REASON_GONE || reason === ARCHIVE_REASON_OUT_OF_SCOPE;
}
