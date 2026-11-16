/**
 * Prueft den Versionsvergleich, an dem haengt, welche Agents
 * Installationsauftraege bekommen.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSupersededTarget, isVersionAtLeast } from '../dist/src/common/agent-version.js';

test('Zahlen statt Text: 0.10.0 ist neuer als 0.9.0', () => {
  assert.equal(isVersionAtLeast('0.10.0', '0.7.0'), true);
  assert.equal(isVersionAtLeast('0.9.0', '0.10.0'), false);
});

test('Grenze und Nachbarn', () => {
  assert.equal(isVersionAtLeast('0.7.0', '0.7.0'), true);
  assert.equal(isVersionAtLeast('0.6.3', '0.7.0'), false);
  assert.equal(isVersionAtLeast('1.0.0', '0.7.0'), true);
});

test('Zusatz zaehlt nicht, fehlende Stellen sind 0', () => {
  assert.equal(isVersionAtLeast('1.0.0-smoke', '0.7.0'), true);
  assert.equal(isVersionAtLeast('0.7', '0.7.0'), true);
});

test('ohne Version nie', () => {
  assert.equal(isVersionAtLeast(null, '0.7.0'), false);
  assert.equal(isVersionAtLeast('', '0.7.0'), false);
});

test('Ueberholt: Geraet laeuft schon mit Neuerem, Ziel ist nicht die aktuelle', () => {
  // Der Fall, der den Anlass gab: Auftrag auf 0.6.3 liegt seit Wochen, das
  // Geraet kommt mit einer von Hand installierten 0.9.1 zurueck.
  assert.equal(isSupersededTarget('0.6.3', '0.9.1', '0.9.2'), true);
  assert.equal(isSupersededTarget('0.9.0', '0.10.0', '0.10.1'), true);
});

test('Nicht ueberholt: Aufwaerts, gleich oder unbekannt', () => {
  assert.equal(isSupersededTarget('0.9.2', '0.6.0', '0.9.2'), false);
  assert.equal(isSupersededTarget('0.7.2', '0.6.3', '0.9.2'), false, 'aufwaerts, wenn auch nicht auf die neueste');
  assert.equal(isSupersededTarget('0.9.1', '0.9.1', '0.9.2'), false, 'gleich meldet der Agent selbst als erledigt');
  assert.equal(isSupersededTarget('0.6.3', null, '0.9.2'), false);
});

test('Nicht ueberholt: bewusst zurueck auf die aktuelle Version', () => {
  assert.equal(isSupersededTarget('0.9.0', '0.9.1', '0.9.0'), false);
});
