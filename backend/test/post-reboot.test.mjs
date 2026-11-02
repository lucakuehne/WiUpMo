/**
 * Prueft die Erkennung von "eingespielt, wartet auf den Neustart"
 * (0x80242014), an der haengt, was sich installieren laesst.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPostRebootPending, postRebootPendingSql } from '../dist/src/common/post-reboot.js';

test('Vorzeichenbehaftet wie vom Agent und vorzeichenlos', () => {
  assert.equal(isPostRebootPending(-2145116140), true);
  assert.equal(isPostRebootPending(0x80242014), true);
});

test('Andere Codes und fehlende Werte', () => {
  assert.equal(isPostRebootPending(-2145124329), false);
  assert.equal(isPostRebootPending(0), false);
  assert.equal(isPostRebootPending(null), false);
  assert.equal(isPostRebootPending(undefined), false);
});

test('SQL vergleicht die vorzeichenlose Form und liefert nie NULL', () => {
  const sql = postRebootPendingSql('s');
  assert.match(sql, /s\.hresult::bigint & 4294967295/);
  assert.match(sql, /= 2149851156/);
  assert.match(sql, /^coalesce\(.*, false\)$/);
});
