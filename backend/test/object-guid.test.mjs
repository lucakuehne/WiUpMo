/**
 * Laeuft mit dem eingebauten Testlaeufer von Node — `node --test`, ohne
 * Framework und ohne Konfiguration.
 *
 * Geprueft wird die Umrechnung der objectGUID. Sie ist der einzige Teil der
 * AD-Anbindung mit reiner Rechenlogik und zugleich der heikelste: Eine falsche
 * Bytefolge ergibt eine GUID, die gueltig aussieht, aber mit keinem Werkzeug
 * uebereinstimmt, das dasselbe Konto anzeigt. Der Fehler faellt dann erst auf,
 * wenn Geraete doppelt angelegt werden.
 *
 * Setzt `pnpm build` voraus.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatObjectGuid, parseOrganizationalUnit } from '../dist/src/ad/ldap.client.js';

test('objectGUID: die ersten drei Gruppen werden umgedreht', () => {
  const bytes = Buffer.from([
    0x0f, 0x1e, 0x2d, 0x3c, // Gruppe 1, im Speicher rueckwaerts
    0x4b, 0x5a, //             Gruppe 2, rueckwaerts
    0x69, 0x78, //             Gruppe 3, rueckwaerts
    0x87, 0x96, //             Gruppe 4, in Reihenfolge
    0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0, // Gruppe 5, in Reihenfolge
  ]);

  assert.equal(formatObjectGuid(bytes), '3c2d1e0f-5a4b-7869-8796-a5b4c3d2e1f0');
});

test('objectGUID: fuehrende Nullen bleiben erhalten', () => {
  const bytes = Buffer.alloc(16);
  bytes[0] = 0x01;

  // Ohne Auffuellen auf zwei Stellen entstuende hier "1-0-0-00-000000".
  assert.equal(formatObjectGuid(bytes), '00000001-0000-0000-0000-000000000000');
});

test('Organisationseinheit: alles nach dem ersten Namensteil', () => {
  assert.equal(
    parseOrganizationalUnit('CN=PC-01,OU=Notebooks,OU=Clients,DC=firma,DC=local'),
    'OU=Notebooks,OU=Clients,DC=firma,DC=local',
  );
});

test('Organisationseinheit: ohne weiteren Pfad null', () => {
  assert.equal(parseOrganizationalUnit('CN=PC-01'), null);
});
