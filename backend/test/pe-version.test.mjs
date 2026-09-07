import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PeVersionError, readProductVersion } from '../dist/src/releases/pe-version.js';

/**
 * Die Pruefstuecke werden hier zusammengebaut statt aus einem echten Binary
 * genommen: Ein 75-MB-Agent gehoert nicht ins Repository, und ein Test, der
 * eine lokal erzeugte Datei voraussetzt, laeuft in der CI nie.
 *
 * Gebaut wird das Minimum, das der Leser durchlaeuft — DOS-Kopf, PE-Kopf,
 * eine Sektion, der dreistufige Ressourcenbaum und der Versionsblock.
 */

const SECTION_RVA = 0x1000;
const SECTION_OFFSET = 0x400;

function pad4(buffer) {
  const rest = buffer.length % 4;
  return rest === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - rest)]);
}

/** Ein Knoten des Versionsblocks: Laenge, Wertlaenge, Typ, Schluessel, Wert, Kinder. */
function node(key, { value = Buffer.alloc(0), text = true, children = [] } = {}) {
  const head = Buffer.concat([Buffer.alloc(6), Buffer.from(`${key}\0`, 'utf16le')]);
  const body = pad4(Buffer.concat([pad4(head), value]));
  const all = Buffer.concat([body, ...children.map(pad4)]);

  all.writeUInt16LE(all.length, 0);
  all.writeUInt16LE(text ? value.length / 2 : value.length, 2);
  all.writeUInt16LE(text ? 1 : 0, 4);

  return all;
}

function versionBlock(productVersion) {
  return node('VS_VERSION_INFO', {
    // VS_FIXEDFILEINFO: binaerer Wert, den der Leser ueberspringen muss.
    value: Buffer.alloc(52),
    text: false,
    children: [
      node('StringFileInfo', {
        children: [
          node('040904b0', {
            children: [
              node('FileDescription', { value: Buffer.from('wiupmo-agent\0', 'utf16le') }),
              node('ProductVersion', { value: Buffer.from(`${productVersion}\0`, 'utf16le') }),
            ],
          }),
        ],
      }),
    ],
  });
}

/** Der dreistufige Ressourcenbaum: Typ, Name, Sprache — und darunter das Blatt. */
function resourceSection(block, { type = 16 } = {}) {
  const directory = (entryId, target, isDirectory) => {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt16LE(0, 12); // keine benannten Eintraege
    buffer.writeUInt16LE(1, 14); // ein nummerierter
    buffer.writeUInt32LE(entryId, 16);
    // Addieren, nicht verodern: Bitoperationen rechnen in JavaScript
    // vorzeichenbehaftet, und writeUInt32LE nimmt keine negative Zahl.
    buffer.writeUInt32LE(isDirectory ? target + 0x80000000 : target, 20);
    return buffer;
  };

  const leaf = Buffer.alloc(16);
  leaf.writeUInt32LE(SECTION_RVA + 88, 0);
  leaf.writeUInt32LE(block.length, 4);

  return Buffer.concat([
    directory(type, 24, true), // 0
    directory(1, 48, true), // 24
    directory(1033, 72, false), // 48
    leaf, // 72
    block, // 88
  ]);
}

function portableExecutable(resources, { plus = true } = {}) {
  const optionalSize = plus ? 240 : 224;
  const headers = Buffer.alloc(SECTION_OFFSET);

  headers.writeUInt16LE(0x5a4d, 0);
  headers.writeUInt32LE(64, 0x3c);
  headers.write('PE\0\0', 64, 'latin1');

  // COFF: Sektionszahl und Groesse des optionalen Kopfes.
  headers.writeUInt16LE(1, 64 + 4 + 2);
  headers.writeUInt16LE(optionalSize, 64 + 4 + 16);

  const optional = 64 + 24;
  headers.writeUInt16LE(plus ? 0x20b : 0x10b, optional);

  // Datenverzeichnis 2 (Ressourcen).
  const directories = optional + (plus ? 112 : 96);
  headers.writeUInt32LE(SECTION_RVA, directories + 2 * 8);
  headers.writeUInt32LE(resources.length, directories + 2 * 8 + 4);

  const section = optional + optionalSize;
  headers.write('.rsrc\0\0\0', section, 'latin1');
  headers.writeUInt32LE(resources.length, section + 8);
  headers.writeUInt32LE(SECTION_RVA, section + 12);
  headers.writeUInt32LE(resources.length, section + 16);
  headers.writeUInt32LE(SECTION_OFFSET, section + 20);

  return Buffer.concat([headers, resources]);
}

async function withFile(buffer, run) {
  const directory = await mkdtemp(join(tmpdir(), 'wiupmo-pe-'));
  const path = join(directory, 'agent.exe');

  try {
    await writeFile(path, buffer);
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('liest die Produktversion aus einer 64-Bit-Datei', async () => {
  const file = portableExecutable(resourceSection(versionBlock('0.1.0+fcd8dfc')));

  const version = await withFile(file, readProductVersion);

  // Der Anhang bleibt stehen; abgeschnitten wird er erst beim Aufnehmen —
  // dort, wo auch der Agent ihn abschneidet.
  assert.equal(version, '0.1.0+fcd8dfc');
});

test('liest die Produktversion auch aus einer 32-Bit-Datei', async () => {
  const file = portableExecutable(resourceSection(versionBlock('2.10.3-rc.1')), { plus: false });

  assert.equal(await withFile(file, readProductVersion), '2.10.3-rc.1');
});

test('ohne Versionsressource wird ein sprechender Fehler geworfen', async () => {
  // Typ 3 ist ein Symbol, nicht die Versionsangabe.
  const file = portableExecutable(resourceSection(versionBlock('1.0.0'), { type: 3 }));

  await withFile(file, async (path) => {
    await assert.rejects(() => readProductVersion(path), PeVersionError);
  });
});

test('eine Datei ohne PE-Kopf wird abgelehnt', async () => {
  await withFile(Buffer.alloc(1024), async (path) => {
    await assert.rejects(() => readProductVersion(path), PeVersionError);
  });
});
