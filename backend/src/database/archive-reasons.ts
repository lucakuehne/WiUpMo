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

/**
 * Fuer ein Geraet, das nur ueber seinen Agent bekannt ist: Sein Computerkonto
 * gibt es, aber nicht in dem, was abgeglichen wird. "Nicht mehr" waere hier
 * falsch — meist war es nie darin, etwa weil der Agent breiter verteilt ist
 * als die ueberwachten OUs, oder weil das Geraet geloescht wurde und sein Agent
 * sich neu registriert hat.
 */
export const ARCHIVE_REASON_NOT_IN_SCOPE =
  'Das Computerkonto liegt ausserhalb der abgeglichenen Bereiche des Verzeichnisses ' +
  'oder wird vom Filter ausgeschlossen.';

export function isAdArchiveReason(reason: string | null): boolean {
  return (
    reason === ARCHIVE_REASON_GONE ||
    reason === ARCHIVE_REASON_OUT_OF_SCOPE ||
    reason === ARCHIVE_REASON_NOT_IN_SCOPE
  );
}
