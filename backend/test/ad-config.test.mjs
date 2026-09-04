/**
 * Zwei reine Rechenfunktionen der AD-Anbindung.
 *
 * Beide erzeugen Zeichenketten, die anschliessend an ein Verzeichnis gehen —
 * ein Fehler darin liefert keine Ausnahme, sondern still das falsche Ergebnis:
 * zu wenige Konten, oder eine Anmeldevorlage, gegen die sich niemand anmelden
 * kann. Genau die Sorte Fehler, die man nicht bemerkt.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dnToDnsName } from '../dist/src/ad/ldap.client.js';
import { effectiveAdFilter } from '../dist/src/settings/settings.types.js';

const base = {
  filterMode: 'guided',
  excludeDisabled: false,
  excludeServers: false,
  filter: '',
};

test('Filter: ohne Einschraenkung nur die Objektklasse', () => {
  assert.equal(effectiveAdFilter(base), '(objectClass=computer)');
});

test('Filter: deaktivierte Konten ausschliessen', () => {
  assert.equal(
    effectiveAdFilter({ ...base, excludeDisabled: true }),
    '(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
  );
});

test('Filter: beide Einschraenkungen werden verundet', () => {
  assert.equal(
    effectiveAdFilter({ ...base, excludeDisabled: true, excludeServers: true }),
    '(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(operatingSystem=*Server*)))',
  );
});

test('Filter: eigener Ausdruck schlaegt die Ankreuzfelder', () => {
  assert.equal(
    effectiveAdFilter({
      ...base,
      filterMode: 'custom',
      excludeDisabled: true,
      filter: '(&(objectClass=computer)(cn=PC-*))',
    }),
    '(&(objectClass=computer)(cn=PC-*))',
  );
});

test('Filter: leerer eigener Ausdruck faellt auf die Objektklasse zurueck', () => {
  // Ein leerer Filter waere serverseitig ein Syntaxfehler, kein "alles".
  assert.equal(effectiveAdFilter({ ...base, filterMode: 'custom', filter: '   ' }), '(objectClass=computer)');
});

test('Domaenenname: nur die DC-Bestandteile, in Reihenfolge', () => {
  assert.equal(dnToDnsName('OU=Clients,OU=Geraete,DC=firma,DC=local'), 'firma.local');
});

test('Domaenenname: ohne DC-Bestandteil null', () => {
  assert.equal(dnToDnsName('OU=Clients'), null);
  assert.equal(dnToDnsName(null), null);
});
