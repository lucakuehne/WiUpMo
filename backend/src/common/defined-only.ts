/**
 * Laesst Felder weg, deren Wert `undefined` ist.
 *
 * Die DTOs sind Klassen, und mit `target: ES2023` legt TypeScript jedes
 * deklarierte Feld an — auch ein nicht gesendetes, dann mit `undefined`. Beim
 * Zusammenfuehren mit dem gespeicherten Stand (`{ ...gespeichert, ...dto }`)
 * ueberschriebe es den vorhandenen Wert, und eine teilweise Aktualisierung
 * loeschte alles, was nicht mitgeschickt wurde.
 */
export function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
