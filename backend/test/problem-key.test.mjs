/**
 * Zusammenfassen der Agent-Meldungen unter „Stoerungen".
 *
 * Zu grob, und verschiedene Stoerungen fallen zusammen; zu fein, und dieselbe
 * steht so oft da, wie es Geraete gibt.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemKey } from '../dist/src/agents/problem-key.js';

test('Zahlen, Uhrzeiten und GUIDs fallen weg', () => {
  assert.equal(
    problemKey('Das Backend gab 2 min vor; verwendet werden 5 min.'),
    problemKey('Das Backend gab 3 min vor; verwendet werden 5 min.'),
  );
  assert.equal(
    problemKey('Auftrag 3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6 nach 12:30:01 abgebrochen'),
    'Auftrag … nach # abgebrochen',
  );
  assert.equal(problemKey('Version 0.8.1  nicht   erreichbar'), 'Version # nicht erreichbar');
});

test('Fehlercodes trennen die Stoerungen', () => {
  assert.notEqual(
    problemKey('Die Update-Suche ist gescheitert: 0x80240022'),
    problemKey('Die Update-Suche ist gescheitert: 0x8024402C'),
  );
  assert.equal(problemKey('Fehler 0x8024402c'), 'Fehler 0x8024402C');
});
