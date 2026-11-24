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
import { isOfflineUpdateWarning, problemKey } from '../dist/src/agents/problem-key.js';

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

test('Offline: Update-Suche gescheitert, und im selben Durchlauf auch das Backend', () => {
  const warnung = 'Update-Zustand nicht lesbar, Check-in ohne Update-Daten. \"Search: Fehler 0x80240438 der Windows-Update-API.\"';
  const at = Date.parse('2026-11-20T08:00:00Z');
  assert.equal(isOfflineUpdateWarning(warnung, at, [at + 400]), true, 'Uebermittlung gleich danach gescheitert');
  assert.equal(isOfflineUpdateWarning(warnung, at, [at + 119_000]), true);
  assert.equal(isOfflineUpdateWarning(warnung, at, []), false, 'Backend erreichbar, WSUS nicht: echte Stoerung');
  assert.equal(isOfflineUpdateWarning(warnung, at, [at + 30 * 60_000]), false, 'spaeterer Durchlauf zaehlt nicht');
  assert.equal(isOfflineUpdateWarning(warnung, at, [at - 1000]), false, 'frueherer Durchlauf zaehlt nicht');
  assert.equal(isOfflineUpdateWarning('Neustart-Status nicht ueber WUApi ermittelbar', at, [at + 400]), false, 'nur die Update-Suche');
});
