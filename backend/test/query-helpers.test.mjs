/**
 * Prueft die beiden Helfer, mit denen Ergebnisse von `dataSource.query()` und
 * DTOs ausgewertet werden. Beide Fehler blieben lange unbemerkt, weil nichts
 * abstuerzte — die Zahlen waren nur falsch, und Update-Auftraege kamen nie an.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definedOnly } from '../dist/src/common/defined-only.js';
import { returnedRows } from '../dist/src/common/query-result.js';

test('UPDATE/DELETE: die Zeilen aus dem Paar [zeilen, anzahl]', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(returnedRows([rows, 3]), rows);
});

test('UPDATE ohne Treffer: leer, nicht Laenge 2', () => {
  assert.deepEqual(returnedRows([[], 0]), []);
});

test('SELECT/INSERT: die Zeilen unveraendert, auch genau zwei', () => {
  const rows = [{ id: 'a' }, { count: 2 }];
  assert.equal(returnedRows(rows), rows);
  assert.deepEqual(returnedRows([]), []);
});

test('definedOnly: nur undefined faellt weg', () => {
  assert.deepEqual(definedOnly({ a: undefined, b: null, c: false, d: '', e: 0, f: [] }), {
    b: null,
    c: false,
    d: '',
    e: 0,
    f: [],
  });
});

test('definedOnly: nicht gesendete Felder einer DTO-Klasse ueberschreiben nichts', () => {
  // So legt das Kompilat ein DTO an: jedes deklarierte Feld existiert.
  class Dto {
    url;
    searchBases;
    timeoutSeconds;
  }
  const dto = Object.assign(new Dto(), { timeoutSeconds: 30 });
  assert.ok('searchBases' in dto);

  const stored = { url: 'ldaps://dc', searchBases: ['OU=Clients'], timeoutSeconds: 60 };
  assert.deepEqual({ ...stored, ...definedOnly(dto) }, { url: 'ldaps://dc', searchBases: ['OU=Clients'], timeoutSeconds: 30 });
});
