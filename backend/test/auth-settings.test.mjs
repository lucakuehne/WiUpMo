/**
 * Übersetzung der abgelösten Anmeldekonfiguration.
 *
 * Der Punkt ist nicht die Umrechnung an sich, sondern dass sie niemanden
 * aussperrt: Eine bestehende Installation soll sich nach dem Update genauso
 * anmelden können wie vorher. Ein Fehler hier fiele erst auf, wenn sich jemand
 * nicht mehr einloggen kann — und dann ist die Oberfläche, über die man es
 * richten würde, ebenfalls zu.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateAuthSettings } from '../dist/src/settings/settings.types.js';

const base = { userDnTemplate: '{username}', allowedGroups: [] };

test('alter Stand "nur lokal"', () => {
  const result = migrateAuthSettings({ ...base, provider: 'local' });
  assert.equal(result.localEnabled, true);
  assert.equal(result.ldapEnabled, false);
});

test('alter Stand "LDAP mit lokalem Rückfall"', () => {
  const result = migrateAuthSettings({ ...base, provider: 'ldap', allowLocalFallback: true });
  assert.equal(result.ldapEnabled, true);
  assert.equal(result.localEnabled, true);
});

test('alter Stand "LDAP ohne Rückfall"', () => {
  const result = migrateAuthSettings({ ...base, provider: 'ldap', allowLocalFallback: false });
  assert.equal(result.ldapEnabled, true);
  assert.equal(result.localEnabled, false);
});

test('alter Stand "LDAP" ohne gesetzten Rückfall lässt lokal offen', () => {
  // Der Schalter war standardmässig an; ein Datensatz ohne das Feld stammt aus
  // einer Zeit, in der er es war.
  const result = migrateAuthSettings({ ...base, provider: 'ldap' });
  assert.equal(result.localEnabled, true);
});

test('neue Form bleibt unverändert', () => {
  const result = migrateAuthSettings({ ...base, localEnabled: false, ldapEnabled: true });
  assert.deepEqual(result, {
    localEnabled: false,
    ldapEnabled: true,
    userDnTemplate: '{username}',
    allowedGroups: [],
  });
});
