/**
 * Apps aus dem Microsoft Store.
 *
 * Der Store installiert und aktualisiert seine Apps ueber denselben Dienst wie
 * Windows Update; sie stehen deshalb in dessen Historie, mit der Produkt-ID des
 * Stores vorn im Titel: „9NRZT3Q9R3DL-Microsoft.WindowsAppRuntime.2". Die
 * Update-Suche liefert sie nie als offen, WSUS verteilt sie nicht. Mitgenommen
 * fuellten sie Katalog und Verlauf mit Paketen, um die sich hier niemand
 * kuemmert — und im Dashboard standen sie als Installationen, an zwei Tagen 47
 * von 64.
 *
 * Erkannt an der Produkt-ID: zwoelf Zeichen ab „9" fuer Store-Apps, vierzehn
 * ab „XP" fuer Programme, die der Store verteilt. Ein Windows-Update-Titel
 * beginnt nie so. Das Muster gilt in JavaScript wie in PostgreSQL (`~`).
 */
export const STORE_APP_TITLE_PATTERN = '^(9[0-9A-Z]{11}|XP[0-9A-Z]{12})-[^ ]';

const STORE_APP_TITLE = new RegExp(STORE_APP_TITLE_PATTERN);

export function isStoreApp(title: string | null | undefined): boolean {
  return typeof title === 'string' && STORE_APP_TITLE.test(title);
}
