/**
 * Sammelt Abfrageparameter und liefert die zugehoerigen Platzhalter.
 *
 * Die Filter der Geraeteliste sind alle optional, die Nummerierung von
 * `$1, $2, …` verschiebt sich also je nachdem, welche gesetzt sind. Von Hand
 * mitgezaehlt ist das eine verlaessliche Fehlerquelle — und der naheliegende
 * Ausweg, Werte in die Zeichenkette zu setzen, waere eine SQL-Injektion.
 */
export class SqlParams {
  private readonly _values: unknown[] = [];

  get values(): unknown[] {
    return this._values;
  }

  add(value: unknown): string {
    this._values.push(value);
    return `$${this._values.length}`;
  }
}
