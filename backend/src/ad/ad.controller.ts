import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import { AdSyncStatus, AdSyncTrigger } from '../database/enums.js';
import { AdSettingsDto } from '../settings/dto/settings.dto.js';
import { SettingsService } from '../settings/settings.service.js';
import { AdSettings, effectiveAdFilter, isAdConfigured } from '../settings/settings.types.js';
import { AdSyncService } from './ad-sync.service.js';
import {
  AdProbeRequestDto,
  AdProbeResultDto,
  ListOusRequestDto,
  OrganizationalUnitDto,
} from './dto/ad-probe.dto.js';
import { AdStatusDto, AdSyncResultDto, AdSyncRunDto, SyncRunsQueryDto } from './dto/ad.dto.js';
import { LdapClient } from './ldap.client.js';

@ApiTags('ad')
@Controller('api/ad')
@UseGuards(SessionGuard)
export class AdController {
  constructor(
    private readonly sync: AdSyncService,
    private readonly settings: SettingsService,
    private readonly ldap: LdapClient,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Konfiguration und letzter Abgleich.' })
  async status(): Promise<AdStatusDto> {
    const config = await this.settings.getAd();
    const runs = await this.sync.recentRuns(1);

    return {
      enabled: isAdConfigured(config),
      url: config.url,
      baseDn: config.baseDn,
      bindDn: config.bindDn,
      bindPasswordSet: config.bindPassword !== '',
      filter: config.filter,
      intervalMinutes: config.intervalMinutes,
      running: this.sync.isRunning,
      lastRun: runs[0] ? toRunDto(runs[0]) : null,
    };
  }

  /**
   * Prueft eine — auch noch nicht gespeicherte — Konfiguration und liefert
   * zurueck, was das Verzeichnis ueber sich selbst sagt.
   *
   * Bewusst kein Fehler bei fehlgeschlagener Verbindung: Das ist im Rahmen
   * einer Einrichtung der Normalfall und keine Ausnahme. Die Meldung gehoert
   * in die Antwort, nicht in einen Statuscode.
   */
  @Post('probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prueft die Verbindung und liest die Eckdaten der Domaene.' })
  async probe(@Body() dto: AdProbeRequestDto): Promise<AdProbeResultDto> {
    const config = await this.merge(dto);
    const filter = effectiveAdFilter(config);

    const empty = {
      dnsHostName: null,
      defaultNamingContext: null,
      namingContexts: [],
      domainDnsName: null,
      domainNetbiosName: null,
      matchedComputers: null,
      effectiveFilter: filter,
    };

    if (!config.url.trim()) {
      return { ok: false, message: 'Es ist keine Serveradresse angegeben.', ...empty };
    }

    try {
      const probe = await this.ldap.probe(config);

      // Nur zaehlen, wenn eine Suchwurzel feststeht — sonst waere der Aufruf
      // eine Suche ueber das gesamte Verzeichnis.
      const matched = config.baseDn.trim()
        ? await this.ldap.countMatches(config)
        : null;

      const summary =
        matched === null
          ? 'Verbindung steht. Es ist noch keine Suchwurzel gewählt.'
          : matched === 0
            ? 'Verbindung steht, der Filter trifft aber kein einziges Konto. Suchwurzel und Filter prüfen.'
            : `Verbindung steht. ${matched} Computerkonten gefunden.`;

      return {
        ok: matched === null || matched > 0,
        message: summary,
        ...probe,
        matchedComputers: matched,
        effectiveFilter: filter,
      };
    } catch (error) {
      return {
        ok: false,
        message: describeLdapError(error),
        ...empty,
      };
    }
  }

  @Post('organizational-units')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Organisationseinheiten zur Auswahl der Suchwurzel.' })
  async organizationalUnits(@Body() dto: ListOusRequestDto): Promise<OrganizationalUnitDto[]> {
    const config = await this.merge(dto);

    const base = dto.base?.trim() || (await this.ldap.probe(config)).defaultNamingContext;
    if (!base) {
      return [];
    }

    const units = await this.ldap.listOrganizationalUnits(config, base);

    // Die Wurzel selbst gehoert dazu: "alles" ist eine legitime Wahl.
    return [{ dn: base, name: base, depth: 0 }, ...units.filter((unit) => unit.dn !== base)];
  }

  /**
   * Verbindet die uebermittelten Werte mit den gespeicherten. Das leere
   * Passwortfeld bedeutet auch hier "unveraendert" — man soll eine Aenderung
   * pruefen koennen, ohne das Kennwort erneut einzutippen.
   */
  private async merge(dto: AdSettingsDto): Promise<AdSettings> {
    const stored = await this.settings.getAd();
    const bindPassword = dto.bindPassword ? dto.bindPassword : stored.bindPassword;
    return { ...stored, ...dto, bindPassword };
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Startet einen Abgleich von Hand.' })
  run(): Promise<AdSyncResultDto> {
    return this.sync.sync(AdSyncTrigger.Manual);
  }

  @Get('sync-runs')
  @ApiOperation({ summary: 'Protokoll der bisherigen Abgleiche.' })
  async runs(@Query() query: SyncRunsQueryDto): Promise<AdSyncRunDto[]> {
    const rows = await this.sync.recentRuns(query.limit);
    return rows.map(toRunDto);
  }
}

function toRunDto(row: Record<string, unknown>): AdSyncRunDto {
  return {
    id: row.id as string,
    startedAt: toIso(row.started_at) ?? '',
    finishedAt: toIso(row.finished_at),
    trigger: row.trigger as AdSyncTrigger,
    devicesFound: Number(row.devices_found),
    devicesCreated: Number(row.devices_created),
    devicesArchived: Number(row.devices_archived),
    status: row.status as AdSyncStatus,
    error: (row.error as string | null) ?? null,
  };
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * Uebersetzt die haeufigsten LDAP-Fehler in einen Satz, der sagt, was zu tun
 * ist. Die Rohmeldungen von Active Directory sind fuer diesen Zweck
 * unbrauchbar: `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext
 * error, data 52e` heisst schlicht "Passwort falsch".
 */
function describeLdapError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/data 52e/i.test(raw)) {
    return 'Benutzername oder Passwort des Dienstkontos ist falsch.';
  }
  if (/data 525/i.test(raw)) {
    return 'Das angegebene Dienstkonto existiert nicht.';
  }
  if (/data 532|data 773/i.test(raw)) {
    return 'Das Passwort des Dienstkontos ist abgelaufen.';
  }
  if (/data 533/i.test(raw)) {
    return 'Das Dienstkonto ist deaktiviert.';
  }
  if (/data 775/i.test(raw)) {
    return 'Das Dienstkonto ist gesperrt.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return 'Der Servername liess sich nicht auflösen. Schreibweise und DNS prüfen.';
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return 'Der Server nimmt keine Verbindung an. Port und Firewall prüfen (389 bzw. 636 für LDAPS).';
  }
  if (/ETIMEDOUT|timeout/i.test(raw)) {
    return 'Zeitüberschreitung beim Verbindungsaufbau. Erreichbarkeit und Port prüfen.';
  }
  if (/certificate|SELF_SIGNED|DEPTH_ZERO|altnames/i.test(raw)) {
    return (
      'Das Zertifikat des Domänencontrollers wurde abgelehnt. Entweder das Zertifikat in Ordnung ' +
      'bringen oder — nur im internen Netz — die Zertifikatsprüfung abschalten.'
    );
  }
  if (/no such object|NO_OBJECT/i.test(raw)) {
    return 'Die Suchwurzel existiert nicht. Bitte aus der Liste wählen.';
  }

  return `Die Verbindung ist fehlgeschlagen: ${raw}`;
}
