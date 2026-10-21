/**
 * Die Zeilen aus dem Ergebnis von `dataSource.query()` bzw. `manager.query()`.
 *
 * TypeORM liefert unter PostgreSQL fuer UPDATE und DELETE nicht die Zeilen,
 * sondern das Paar `[zeilen, anzahl]` — auch mit RETURNING. Ein `.length`
 * darauf ist immer 2 und `[0]` das Zeilen-Array selbst. So kam es, dass kein
 * Agent je einen Update-Auftrag erhielt, der AD-Abgleich bei jedem Lauf zwei
 * archivierte Geraete meldete und die Aufbewahrung nach dem ersten Stapel
 * aufhoerte.
 *
 * Fuer SELECT und INSERT kommen die Zeilen unveraendert durch. Verwechseln
 * laesst sich das nicht: Zeilen sind Objekte, nie Arrays.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }

  return result as T[];
}
