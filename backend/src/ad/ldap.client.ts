import { Injectable, Logger } from '@nestjs/common';
import { Client, type Entry } from 'ldapts';
import { AdSettings, effectiveAdFilter, effectiveSearchBases } from '../settings/settings.types.js';

/** Was die Sondierung ueber das Verzeichnis herausfindet. */
export interface AdProbe {
  dnsHostName: string | null;

  /** Wurzel der Domaene, z. B. `DC=firma,DC=local`. Der Vorschlag fuer die Suchwurzel. */
  defaultNamingContext: string | null;

  namingContexts: string[];

  /** Aus dem Namenskontext abgeleitet, z. B. `firma.local` — der UPN-Zusatz. */
  domainDnsName: string | null;

  /** Kurzname der Domaene, z. B. `FIRMA`. */
  domainNetbiosName: string | null;
}

export interface OrganizationalUnit {
  dn: string;
  name: string;

  /** Schachtelungstiefe unterhalb der Suchwurzel, fuer die Einrueckung. */
  depth: number;
}

export interface AdGroup {
  dn: string;
  name: string;

  /** `sAMAccountName`, oft der Name, unter dem die Gruppe bekannt ist. */
  accountName: string | null;
}

/**
 * `LDAP_MATCHING_RULE_IN_CHAIN`. Loest Gruppenketten auf: Ein Benutzer, der nur
 * ueber eine untergeordnete Gruppe Mitglied ist, wird damit gefunden. Ohne
 * diese Regel muesste man die Verschachtelung selbst nachlaufen — mit einer
 * Abfrage je Ebene und ohne Schutz gegen Zyklen.
 */
const IN_CHAIN = '1.2.840.113556.1.4.1941';

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
    const bases = effectiveSearchBases(config);
    const filter = effectiveAdFilter(config);

    return this.withClient(config, async (client) => {
      // Ueber die objectGUID zusammengefuehrt: Ueberschneiden sich zwei
      // gewaehlte Bereiche, taeuchte dasselbe Konto sonst mehrfach auf — und
      // der Abgleich zaehlte es doppelt.
      const byGuid = new Map<string, AdComputer>();

      for (const base of bases) {
        const { searchEntries } = await client.search(base, {
          scope: 'sub',
          filter,
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

        for (const entry of searchEntries) {
          const computer = this.toComputer(entry);
          if (computer) {
            byGuid.set(computer.objectGuid, computer);
          }
        }
      }

      this.logger.log(
        `${byGuid.size} Computerkonten aus dem AD gelesen (${bases.length} Bereich(e)).`,
      );
      return [...byGuid.values()];
    });
  }

  /**
   * Verbindet, meldet sich an und fragt das Verzeichnis nach sich selbst.
   *
   * Die RootDSE beantwortet die Fragen, die sonst jemand von Hand eintippen
   * muesste: Wie heisst die Domaene, wo ist ihre Wurzel, welche Namenskontexte
   * gibt es. Damit wird aus dem Ausfuellen eines Formulars ein Auswaehlen.
   */
  async probe(config: AdSettings): Promise<AdProbe> {
    return this.withClient(config, async (client) => {
      const { searchEntries } = await client.search('', {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: [
          'defaultNamingContext',
          'rootDomainNamingContext',
          'namingContexts',
          'dnsHostName',
        ],
      });

      const root = searchEntries[0] ?? {};
      const defaultNamingContext = asString(root.defaultNamingContext);

      return {
        dnsHostName: asString(root.dnsHostName),
        defaultNamingContext,
        namingContexts: asStrings(root.namingContexts),
        domainDnsName: dnToDnsName(defaultNamingContext),
        domainNetbiosName: await this.readNetbiosName(
          client,
          asString(root.rootDomainNamingContext) ?? defaultNamingContext,
          defaultNamingContext,
        ),
      };
    });
  }

  /**
   * Zaehlt, wie viele Konten der eingestellte Filter unterhalb der Suchwurzel
   * trifft. Das ist die eigentliche Probe aufs Exempel — eine Verbindung, die
   * steht, aber null Treffer liefert, ist genauso unbrauchbar wie gar keine.
   */
  async countMatches(config: AdSettings): Promise<number> {
    const bases = effectiveSearchBases(config);
    const filter = effectiveAdFilter(config);

    return this.withClient(config, async (client) => {
      const seen = new Set<string>();

      for (const base of bases) {
        const { searchEntries } = await client.search(base, {
          scope: 'sub',
          filter,
          paged: { pageSize: config.pageSize },
          attributes: ['distinguishedName'],
        });

        for (const entry of searchEntries) {
          seen.add(asString(entry.distinguishedName) ?? String(entry.dn));
        }
      }

      return seen.size;
    });
  }

  /** Gruppen unterhalb der Domaenenwurzel, fuer die Auswahl im Frontend. */
  async listGroups(config: AdSettings, search: string): Promise<AdGroup[]> {
    const base = config.baseDn.trim();
    if (!base) {
      return [];
    }

    // Der Suchbegriff wird maskiert: Ein `*` oder eine Klammer darin waere
    // sonst Teil des Filterausdrucks und nicht des gesuchten Textes.
    const term = search.trim() ? `*${escapeFilterValue(search.trim())}*` : '*';

    return this.withClient(config, async (client) => {
      const { searchEntries } = await client.search(base, {
        scope: 'sub',
        filter: `(&(objectClass=group)(|(cn=${term})(sAMAccountName=${term})))`,
        paged: { pageSize: 500 },
        sizeLimit: 500,
        attributes: ['distinguishedName', 'cn', 'sAMAccountName'],
      });

      return searchEntries
        .map((entry) => {
          const dn = asString(entry.distinguishedName) ?? String(entry.dn);
          return {
            dn,
            name: asString(entry.cn) ?? dn.split(',')[0],
            accountName: asString(entry.sAMAccountName),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    });
  }

  /**
   * Prueft, ob ein Benutzer Mitglied einer der Gruppen ist — verschachtelte
   * Mitgliedschaften eingeschlossen.
   *
   * Die Abfrage laeuft mit dem Dienstkonto, nicht mit dem des Benutzers: Ein
   * Benutzer darf zwar in aller Regel seine eigenen Mitgliedschaften lesen,
   * aber eben nicht ueberall — und die Anmeldung soll nicht davon abhaengen,
   * wie grosszuegig die Berechtigungen im Verzeichnis gesetzt sind.
   */
  async isMemberOfAny(config: AdSettings, userDn: string, groups: string[]): Promise<boolean> {
    if (groups.length === 0) {
      return true;
    }

    return this.withClient(config, async (client) => {
      const clauses = groups.map((group) => `(memberOf:${IN_CHAIN}:=${escapeFilterValue(group)})`);

      const { searchEntries } = await client.search(userDn, {
        scope: 'base',
        filter: clauses.length === 1 ? clauses[0] : `(|${clauses.join('')})`,
        attributes: ['distinguishedName'],
      });

      return searchEntries.length > 0;
    });
  }

  /**
   * Findet den vollstaendigen DN zu einem eingegebenen Benutzernamen.
   *
   * Gesucht wird ueber beide gebraeuchlichen Kennungen, weil im Anmeldefeld
   * mal `benutzer` und mal `benutzer@firma.local` steht — und die
   * Gruppenpruefung braucht den DN, nicht den Anmeldenamen.
   */
  async findUserDn(config: AdSettings, username: string): Promise<string | null> {
    const base = config.baseDn.trim();
    if (!base) {
      return null;
    }

    const escaped = escapeFilterValue(username);
    const short = escapeFilterValue(username.split('@')[0].split('\\').pop() ?? username);

    return this.withClient(config, async (client) => {
      const { searchEntries } = await client.search(base, {
        scope: 'sub',
        filter: `(&(objectClass=user)(|(userPrincipalName=${escaped})(sAMAccountName=${short})))`,
        sizeLimit: 2,
        attributes: ['distinguishedName'],
      });

      // Mehr als ein Treffer heisst, dass der Name nicht eindeutig ist. Dann
      // lieber ablehnen als raten, welches Konto gemeint war.
      if (searchEntries.length !== 1) {
        return null;
      }

      return asString(searchEntries[0].distinguishedName) ?? String(searchEntries[0].dn);
    });
  }

  /** Organisationseinheiten unterhalb eines Knotens, fuer die Auswahl im Frontend. */
  async listOrganizationalUnits(config: AdSettings, base: string): Promise<OrganizationalUnit[]> {
    return this.withClient(config, async (client) => {
      const { searchEntries } = await client.search(base, {
        scope: 'sub',
        filter: '(|(objectClass=organizationalUnit)(objectClass=container))',
        paged: { pageSize: 500 },
        attributes: ['distinguishedName', 'name'],
      });

      const baseParts = base.split(',').length;

      return searchEntries
        .map((entry) => {
          const dn = asString(entry.distinguishedName) ?? String(entry.dn);
          return {
            dn,
            name: asString(entry.name) ?? dn.split(',')[0],
            depth: Math.max(0, dn.split(',').length - baseParts),
          };
        })
        // Nach dem vollstaendigen Namen von hinten sortiert, damit
        // untergeordnete Einheiten direkt unter ihrer uebergeordneten stehen.
        .sort((a, b) => reverseDn(a.dn).localeCompare(reverseDn(b.dn), 'de'));
    });
  }

  /**
   * Der NetBIOS-Name steht nicht in der RootDSE, sondern im
   * Partitions-Container der Konfiguration. Er ist nur ein Komfortwert — misslingt
   * die Abfrage, faellt die Anzeige auf den abgeleiteten Namen zurueck.
   */
  private async readNetbiosName(
    client: Client,
    configurationRoot: string | null,
    defaultNamingContext: string | null,
  ): Promise<string | null> {
    if (!configurationRoot || !defaultNamingContext) {
      return null;
    }

    try {
      const { searchEntries } = await client.search(`CN=Partitions,CN=Configuration,${configurationRoot}`, {
        scope: 'sub',
        filter: `(&(objectClass=crossRef)(nCName=${defaultNamingContext}))`,
        attributes: ['nETBIOSName'],
      });

      return asString(searchEntries[0]?.nETBIOSName);
    } catch {
      const derived = dnToDnsName(defaultNamingContext)?.split('.')[0];
      return derived ? derived.toUpperCase() : null;
    }
  }

  private async withClient<T>(config: AdSettings, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      url: config.url,
      timeout: config.timeoutSeconds * 1000,
      connectTimeout: config.timeoutSeconds * 1000,
      tlsOptions: {
        rejectUnauthorized: config.tlsRejectUnauthorized,
        // Ist ein Zertifikat der ausstellenden Stelle hinterlegt, wird
        // ausschliesslich dagegen geprueft. Das ist der richtige Weg bei einer
        // internen PKI — im Gegensatz zum Abschalten der Pruefung bleibt ein
        // untergeschobener Server erkennbar.
        ca: config.caCertificate.trim() ? [config.caCertificate] : undefined,
      },
    });

    try {
      await client.bind(config.bindDn, config.bindPassword);
      return await work(client);
    } finally {
      await client.unbind().catch(() => {
        // Verbindung ist ohnehin am Ende.
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

/**
 * Maskiert einen Wert fuer einen LDAP-Filter nach RFC 4515.
 *
 * Ohne das koennte ein Benutzername wie `*)(objectClass=*` den Filter
 * umschreiben — bei einer Abfrage, die ueber die Anmeldung erreichbar ist,
 * ist das keine theoretische Sorge.
 */
function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\5c';
      case '*':
        return '\\2a';
      case '(':
        return '\\28';
      case ')':
        return '\\29';
      default:
        return '\\00';
    }
  });
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

/** `DC=firma,DC=local` wird zu `firma.local` — der UPN-Zusatz der Domaene. */
export function dnToDnsName(dn: string | null): string | null {
  if (!dn) {
    return null;
  }

  const parts = dn
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.toLowerCase().startsWith('dc='))
    .map((part) => part.slice(3));

  return parts.length > 0 ? parts.join('.') : null;
}

/** Dreht die Bestandteile eines DN um, damit sich hierarchisch sortieren laesst. */
function reverseDn(dn: string): string {
  return dn.split(',').reverse().join(',').toLowerCase();
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
