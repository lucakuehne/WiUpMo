/**
 * Prueft die Umgebungsvalidierung gegen die Konstellationen, die Docker
 * Compose tatsaechlich erzeugt.
 *
 * Anlass war ein Startfehler im Container: `AGENT_ENROLLMENT_TOKEN` ist
 * optional, Compose uebergibt eine nicht gesetzte Variable aber als `VAR=` —
 * also als leere Zeichenkette, nicht als fehlenden Wert. `@IsOptional()`
 * ueberspringt nur `null` und `undefined`, die Laengenpruefung schlug also zu
 * und das Backend startete nicht.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnv } from '../dist/src/config/env.validation.js';

/** Das Minimum, ohne das ein Start ohnehin sinnlos waere. */
const required = {
  DB_HOST: 'postgres',
  DB_USER: 'wiupmo',
  DB_PASSWORD: 'geheim',
  DB_NAME: 'wiupmo',
};

test('leere optionale Variablen sind zulaessig — so uebergibt Compose sie', () => {
  const parsed = validateEnv({
    ...required,
    AGENT_ENROLLMENT_TOKEN: '',
    JWT_SECRET: '',
    CORS_ORIGINS: '',
    COOKIE_SECURE: '',
    PORT: '',
  });

  assert.equal(parsed.AGENT_ENROLLMENT_TOKEN, undefined);
  assert.equal(parsed.JWT_SECRET, undefined);
  assert.equal(parsed.PORT, 3000, 'ohne Angabe gilt der Vorgabewert');
});

test('vollstaendig fehlende optionale Variablen sind ebenfalls zulaessig', () => {
  const parsed = validateEnv({ ...required });
  assert.equal(parsed.AGENT_ENROLLMENT_TOKEN, undefined);
  assert.equal(parsed.PORT, 3000);
  assert.equal(parsed.DB_PORT, 5432);
  assert.equal(parsed.DB_SSL, false);
});

test('gesetzte Zahlen- und Wahrheitswerte werden umgewandelt', () => {
  const parsed = validateEnv({ ...required, PORT: '8080', DB_SSL: 'true', COOKIE_SECURE: 'yes' });
  assert.equal(parsed.PORT, 8080);
  assert.equal(parsed.DB_SSL, true);
  assert.equal(parsed.COOKIE_SECURE, true);
});

test('ein gesetztes, aber zu kurzes Token wird abgelehnt', () => {
  // Die Pruefung soll nicht verschwinden — nur die leere Zeichenkette ist
  // ausgenommen, ein tatsaechlich gesetzter Wert bleibt geprueft.
  assert.throws(
    () => validateEnv({ ...required, AGENT_ENROLLMENT_TOKEN: 'zu-kurz' }),
    /AGENT_ENROLLMENT_TOKEN/,
  );
});

test('ein gueltiges Token kommt unveraendert durch', () => {
  const token = 'a'.repeat(32);
  assert.equal(validateEnv({ ...required, AGENT_ENROLLMENT_TOKEN: token }).AGENT_ENROLLMENT_TOKEN, token);
});

test('fehlende Pflichtvariablen brechen den Start ab', () => {
  assert.throws(() => validateEnv({ DB_HOST: 'postgres' }), /DB_USER/);
});
