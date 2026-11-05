/**
 * Erkennung von Store-Apps in der Windows-Update-Historie.
 *
 * Ein Fehler hier faellt nicht auf: Zu weit gefasst, verschwinden echte
 * Windows-Updates still aus Katalog und Verlauf; zu eng, fuellen Store-Pakete
 * wieder das Dashboard.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStoreApp } from '../dist/src/common/store-apps.js';

test('Store-Apps und vom Store verteilte Programme', () => {
  for (const title of [
    '9NRZT3Q9R3DL-Microsoft.WindowsAppRuntime.2',
    '9WZDNCRFJ3TJ-Microsoft.Netflix',
    'XP89DCGQ3K6VLD-Microsoft.PowerToys',
  ]) {
    assert.equal(isStoreApp(title), true, title);
  }
});

test('Windows-Updates bleiben', () => {
  for (const title of [
    '2026-10 Kumulatives Update für Windows 11, version 25H2 für x64-basierte Systeme (KB5127648) (26200.9711)',
    'Security Intelligence-Update für Microsoft Defender Antivirus – KB2267602 (Version 1.463.1)',
    'Update für Windows Security platform - KB5007651 (Version 10.0.29680.1000)',
    'Definitionsupdate für Microsoft Office 2013 (KB3115404) 64-Bit-Edition',
    'Intel - Display - 31.0.101.5592',
    '9NRZT3Q9R3DL Microsoft ohne Bindestrich',
    '9nrzt3q9r3dl-kleingeschrieben',
    null,
    undefined,
  ]) {
    assert.equal(isStoreApp(title), false, String(title));
  }
});
