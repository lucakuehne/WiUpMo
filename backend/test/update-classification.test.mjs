/**
 * Prueft den SQL-Ausdruck, der einem Update seinen Typ gibt. Ob PostgreSQL
 * ihn richtig auswertet, zeigt der Smoke-Test; hier geht es um Reihenfolge
 * und Vollstaendigkeit.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UPDATE_CLASSIFICATIONS,
  classificationSql,
} from '../dist/src/common/update-classification.js';

const sql = classificationSql('u');

test('Jeder Typ ausser "other" hat einen Zweig, "other" ist der Rest', () => {
  for (const type of UPDATE_CLASSIFICATIONS.filter((t) => t !== 'other')) {
    assert.match(sql, new RegExp(`THEN '${type}'`), type);
  }
  assert.match(sql, /ELSE 'other' END\)$/);
});

test('"Updates" erst nach allen anderen Namen, die Sicherheitsmarke danach', () => {
  const updates = sql.indexOf("ARRAY['Updates']");
  assert.ok(updates > sql.indexOf("'Security Updates'"));
  assert.ok(updates > sql.indexOf("'Drivers'"));
  assert.ok(updates > sql.indexOf("'Upgrades'"));
  assert.ok(sql.indexOf('u.is_security') > updates);
});

test('Deutsche und englische Namen', () => {
  assert.match(sql, /'Security Updates', 'Sicherheitsupdates'/);
  assert.match(sql, /'Drivers', 'Treiber'/);
});

test('Der Alias steht an jeder Spalte', () => {
  assert.equal(sql.match(/[a-z_]+\.categories/g).every((c) => c === 'u.categories'), true);
  assert.equal(classificationSql('x').includes('u.'), false);
});
