/**
 * Sammelt Abfrageparameter und liefert die zugehoerigen Platzhalter.
 *
 * Die Filter der Geraeteliste sind alle optional, die Nummerierung von
 * `$1, $2, …` verschiebt sich also je nachdem, welche gesetzt sind. Von Hand
 * mitgezaehlt ist das eine verlaessliche Fehlerquelle — und der naheliegende
 * Ausweg, Werte in die Zeichenkette zu setzen, waere eine SQL-Injektion.
 */
/**
 * Erzeugt CSV.
 *
 * Excel erkennt das Trennzeichen nur ueber die `sep=`-Zeile — mit Komma
 * landet in einer deutschsprachigen Installation alles in einer Spalte. Und
 * ohne BOM werden Umlaute zu Kauderwelsch, weil Excel die Datei sonst als
 * Windows-1252 liest.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const escape = (value: string | number | null): string => {
    if (value === null || value === undefined) {
      return '';
    }

    const text = String(value);
    // Ein fuehrendes =, +, - oder @ macht aus dem Wert in Excel eine Formel.
    const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;

    return /[";\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };

  const lines = [headers.map(escape).join(';'), ...rows.map((row) => row.map(escape).join(';'))];

  return `﻿sep=;\r\n${lines.join('\r\n')}\r\n`;
}

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
