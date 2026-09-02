import { Injectable, Logger } from '@nestjs/common';
import { Client, type Entry } from 'ldapts';
import { AdSettings } from '../settings/settings.types.js';

/** Ein Computerkonto, auf das Noetigste eingedampft. */
export interface AdComputer {
  objectGuid: string;
  distinguishedName: string;
  hostname: string;
  organizationalUnit: string | null;
  operatingSystem: string | null;
  operatingSystemVersion: string | null;
}

@Injectable()
export class LdapClient {
  private readonly logger = new Logger(LdapClient.name);

  /**
   * Liest alle Computerkonten unterhalb der Suchwurzel.
   *
   * Die Suche laeuft seitenweise, weil ein Domaenencontroller ohne Paging
   * hoechstens 1000 Eintraege zurueckgibt und den Rest kommentarlos
   * weglaesst — bei einer groesseren Flotte waere die Folge, dass die fehlenden
   * Geraete als "im AD verschwunden" archiviert wuerden.
   */
  async fetchComputers(config: AdSettings): Promise<AdComputer[]> {
    const client = new Client({
      url: config.url,
      timeout: config.timeoutSeconds * 1000,
      connectTimeout: config.timeoutSeconds * 1000,
      tlsOptions: { rejectUnauthorized: config.tlsRejectUnauthorized },
    });

    try {
      await client.bind(config.bindDn, config.bindPassword);

      const { searchEntries } = await client.search(config.baseDn, {
        scope: 'sub',
        filter: config.filter,
        paged: { pageSize: config.pageSize },
        attributes: [
          'objectGUID',
          'distinguishedName',
          'cn',
          'dNSHostName',
          'operatingSystem',
          'operatingSystemVersion',
        ],
        // objectGUID ist binaer. Ohne diese Angabe kaeme eine kaputte
        // Zeichenkette statt der 16 Bytes an.
        explicitBufferAttributes: ['objectGUID'],
      });

      const computers: AdComputer[] = [];

      for (const entry of searchEntries) {
        const computer = this.toComputer(entry);
        if (computer) {
          computers.push(computer);
        }
      }

      this.logger.log(`${computers.length} Computerkonten aus dem AD gelesen.`);
      return computers;
    } finally {
      await client.unbind().catch(() => {
        // Die Verbindung ist ohnehin am Ende; ein Fehler beim Abmelden darf
        // den Abgleich nicht nachtraeglich scheitern lassen.
      });
    }
  }

  private toComputer(entry: Entry): AdComputer | null {
    const guidBuffer = asBuffer(entry.objectGUID);
    if (!guidBuffer || guidBuffer.length !== 16) {
      this.logger.warn(`Eintrag ohne verwertbare objectGUID uebersprungen: ${entry.dn}`);
      return null;
    }

    const dn = asString(entry.distinguishedName) ?? String(entry.dn);
    const cn = asString(entry.cn);
    const dnsHostName = asString(entry.dNSHostName);

    // Der Kurzname, nicht der FQDN: der Agent meldet Environment.MachineName,
    // und ueber diesen Namen findet das Enrollment ein Geraet wieder, das noch
    // keine GUID hat.
    const hostname = cn ?? dnsHostName?.split('.')[0] ?? null;
    if (!hostname) {
      this.logger.warn(`Eintrag ohne Namen uebersprungen: ${dn}`);
      return null;
    }

    return {
      objectGuid: formatObjectGuid(guidBuffer),
      distinguishedName: dn,
      hostname,
      organizationalUnit: parseOrganizationalUnit(dn),
      operatingSystem: asString(entry.operatingSystem),
      operatingSystemVersion: asString(entry.operatingSystemVersion),
    };
  }
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value) && Buffer.isBuffer(value[0])) {
    return value[0];
  }
  return null;
}

/**
 * Wandelt die 16 Bytes einer objectGUID in die uebliche Schreibweise.
 *
 * Die ersten drei Gruppen liegen im Speicher in umgekehrter Bytefolge —
 * ein Erbe der Windows-Struktur `GUID`. Wer sie einfach durchschreibt,
 * bekommt eine GUID, die zwar gueltig aussieht, aber mit keinem Werkzeug
 * uebereinstimmt, das dasselbe Konto anzeigt.
 */
export function formatObjectGuid(buffer: Buffer): string {
  const hex = (index: number): string => buffer[index].toString(16).padStart(2, '0');

  const part = (...indexes: number[]): string => indexes.map(hex).join('');

  return [
    part(3, 2, 1, 0),
    part(5, 4),
    part(7, 6),
    part(8, 9),
    part(10, 11, 12, 13, 14, 15),
  ].join('-');
}

/**
 * Der Pfad ohne den ersten Namensteil, also `OU=Notebooks,OU=Clients,DC=…`
 * aus `CN=PC-01,OU=Notebooks,OU=Clients,DC=…`. Das ist der Wert, nach dem im
 * Frontend gefiltert und gruppiert wird.
 */
export function parseOrganizationalUnit(dn: string): string | null {
  const separator = dn.indexOf(',');
  return separator > 0 ? dn.slice(separator + 1) : null;
}
