/**
 * Prueft den Versionsvergleich, an dem haengt, welche Agents
 * Installationsauftraege bekommen.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVersionAtLeast } from '../dist/src/common/agent-version.js';

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
