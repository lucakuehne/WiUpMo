import { open, type FileHandle } from 'node:fs/promises';

/**
 * Liest die Produktversion aus dem Versionsressourcen-Block einer Windows-EXE.
 *
 * Der Grund fuer den Aufwand: Die Version, unter der ein Release hinterlegt
 * wird, muss exakt der entsprechen, die der Agent von sich meldet. Weichen sie
 * ab, laeuft ein Update-Auftrag endlos — das Backend beauftragt Version X, das
 * getauschte Binary meldet Y, und beim naechsten Check-in beginnt dasselbe von
 * vorn. Ein Eingabefeld kann diese Gleichheit nicht sicherstellen, die Datei
 * selbst schon.
 *
 * Gelesen wird `ProductVersion` aus dem `StringFileInfo`-Block: Dort steht bei
 * einer .NET-Anwendung die `AssemblyInformationalVersion` — genau der Wert, den
 * `AgentVersion.Current` im Agent zurueckgibt. `FileVersion` waere der falsche
 * Griff: Windows normalisiert sie auf vier Zahlen, aus `0.1.0` wird `0.1.0.0`.
 */

/** Wird geworfen, wenn die Datei keine lesbare Versionsangabe enthaelt. */
export class PeVersionError extends Error {}

const RT_VERSION = 16;
const RESOURCE_DIRECTORY_INDEX = 2;

export async function readProductVersion(path: string): Promise<string> {
  const file = await open(path, 'r');

  try {
    return await read(file);
  } finally {
    await file.close();
  }
}

async function read(file: FileHandle): Promise<string> {
  const dos = await readAt(file, 0, 0x40);

  if (dos.readUInt16LE(0) !== 0x5a4d) {
    throw new PeVersionError('Die Datei ist keine Windows-Programmdatei (fehlende MZ-Kennung).');
  }

  const peOffset = dos.readUInt32LE(0x3c);
  const coff = await readAt(file, peOffset, 24);

  if (coff.readUInt32LE(0) !== 0x00004550) {
    throw new PeVersionError('Die Datei ist keine Windows-Programmdatei (fehlende PE-Kennung).');
  }

  const sectionCount = coff.readUInt16LE(6);
  const optionalHeaderSize = coff.readUInt16LE(20);
  const optional = await readAt(file, peOffset + 24, optionalHeaderSize);

  // PE32+ schiebt die Datenverzeichnisse um 16 Byte nach hinten: dort sind
  // vier Felder 64 statt 32 Bit breit.
  const directoriesAt = optional.readUInt16LE(0) === 0x20b ? 112 : 96;
  const resourceRva = optional.readUInt32LE(directoriesAt + RESOURCE_DIRECTORY_INDEX * 8);

  if (resourceRva === 0) {
    throw new PeVersionError('Die Datei enthaelt keine Ressourcen.');
  }

  const sections = await readAt(file, peOffset + 24 + optionalHeaderSize, sectionCount * 40);
  const section = findSection(sections, sectionCount, resourceRva);

  // Der gesamte Ressourcenabschnitt auf einmal: Er ist selbst bei einem
  // 75-MB-Binary nur einige Kilobyte gross, und alle Verweise darin sind
  // relativ zu seinem Anfang.
  const resources = await readAt(file, section.rawOffset, section.rawSize);
  const versionRva = findVersionResource(resources, section.virtualAddress);

  return parseVersionBlock(resources.subarray(versionRva.start, versionRva.end));
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);

  if (bytesRead < length) {
    throw new PeVersionError('Die Datei endet fruehzeitig; sie ist vermutlich unvollstaendig.');
  }

  return buffer;
}

interface Section {
  virtualAddress: number;
  rawOffset: number;
  rawSize: number;
}

function findSection(sections: Buffer, count: number, rva: number): Section {
  for (let i = 0; i < count; i++) {
    const at = i * 40;
    const virtualAddress = sections.readUInt32LE(at + 12);
    const virtualSize = sections.readUInt32LE(at + 8);
    const rawSize = sections.readUInt32LE(at + 16);

    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return { virtualAddress, rawOffset: sections.readUInt32LE(at + 20), rawSize };
    }
  }

  throw new PeVersionError('Der Ressourcenabschnitt ist nicht auffindbar.');
}

/**
 * Steigt durch die drei Ebenen des Ressourcenbaums: Typ, Name, Sprache. Auf der
 * ersten wird gezielt nach <c>RT_VERSION</c> gesucht, auf den beiden anderen
 * genuegt der erste Eintrag — mehr als eine Versionsressource legt kein
 * Uebersetzer an.
 */
function findVersionResource(resources: Buffer, sectionRva: number): { start: number; end: number } {
  const byType = entries(resources, 0).find((entry) => entry.id === RT_VERSION);

  if (!byType?.isDirectory) {
    throw new PeVersionError('Die Datei enthaelt keine Versionsangabe.');
  }

  const byName = entries(resources, byType.offset)[0];
  if (!byName?.isDirectory) {
    throw new PeVersionError('Die Versionsangabe ist unerwartet aufgebaut.');
  }

  const byLanguage = entries(resources, byName.offset)[0];
  if (!byLanguage || byLanguage.isDirectory) {
    throw new PeVersionError('Die Versionsangabe ist unerwartet aufgebaut.');
  }

  // Das Blatt verweist ueber eine RVA, nicht ueber einen abschnittsrelativen
  // Versatz — anders als jeder Verweis darueber.
  const start = resources.readUInt32LE(byLanguage.offset) - sectionRva;
  const size = resources.readUInt32LE(byLanguage.offset + 4);

  if (start < 0 || start + size > resources.length) {
    throw new PeVersionError('Die Versionsangabe liegt ausserhalb des Ressourcenabschnitts.');
  }

  return { start, end: start + size };
}

interface DirectoryEntry {
  id: number;
  offset: number;
  isDirectory: boolean;
}

function entries(resources: Buffer, at: number): DirectoryEntry[] {
  const named = resources.readUInt16LE(at + 12);
  const numbered = resources.readUInt16LE(at + 14);
  const result: DirectoryEntry[] = [];

  for (let i = 0; i < named + numbered; i++) {
    const entry = at + 16 + i * 8;
    const offset = resources.readUInt32LE(entry + 4);

    result.push({
      id: resources.readUInt32LE(entry),
      // Das oberste Bit unterscheidet Unterverzeichnis von Blatt.
      isDirectory: (offset & 0x80000000) !== 0,
      offset: offset & 0x7fffffff,
    });
  }

  return result;
}

interface VersionNode {
  key: string;
  value: Buffer;
  isText: boolean;
  childrenAt: number;
  end: number;
}

/**
 * Der Block ist eine Folge gleich aufgebauter, ineinander geschachtelter
 * Knoten. Jeder beginnt mit Laenge, Wertlaenge und Typ, danach folgt ein
 * nullterminierter UTF-16-Schluessel; Wert und Kinder stehen jeweils auf die
 * naechste durch vier teilbare Position aufgerundet.
 */
function readNode(block: Buffer, at: number): VersionNode {
  const length = block.readUInt16LE(at);
  const valueLength = block.readUInt16LE(at + 2);
  const isText = block.readUInt16LE(at + 4) === 1;

  let keyEnd = at + 6;
  while (keyEnd + 1 < block.length && block.readUInt16LE(keyEnd) !== 0) {
    keyEnd += 2;
  }

  const key = block.toString('utf16le', at + 6, keyEnd);
  const valueAt = align(keyEnd + 2);

  // Bei Text zaehlt die Wertlaenge Zeichen, sonst Bytes.
  const valueBytes = isText ? valueLength * 2 : valueLength;

  return {
    key,
    value: block.subarray(valueAt, Math.min(valueAt + valueBytes, block.length)),
    isText,
    childrenAt: align(valueAt + valueBytes),
    end: Math.min(at + length, block.length),
  };
}

function align(offset: number): number {
  return (offset + 3) & ~3;
}

function* children(block: Buffer, node: VersionNode): Generator<VersionNode> {
  let at = node.childrenAt;

  while (at + 6 <= node.end) {
    const child = readNode(block, at);

    // Eine Laenge von null wuerde die Schleife festsetzen.
    if (child.end <= at) {
      return;
    }

    yield child;
    at = align(child.end);
  }
}

function parseVersionBlock(block: Buffer): string {
  const root = readNode(block, 0);

  for (const info of children(block, root)) {
    if (info.key !== 'StringFileInfo') {
      continue;
    }

    // Darunter je Sprache eine Tabelle, darin die einzelnen Eintraege.
    for (const table of children(block, info)) {
      for (const entry of children(block, table)) {
        if (entry.key === 'ProductVersion' && entry.isText) {
          const value = entry.value.toString('utf16le').replace(/\0.*$/s, '').trim();

          if (value !== '') {
            return value;
          }
        }
      }
    }
  }

  throw new PeVersionError('Die Datei enthaelt keine Produktversion.');
}
