import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SqlParams, toCsv } from '../common/sql-params.js';
import { DeviceStatus, UpdateEventType, UpdateSource, UpdateState } from '../database/enums.js';
import {
  DeviceCheckinDto,
  DeviceDetailDto,
  DeviceUpdateDto,
  TimelineDto,
  TimelineEntryDto,
  TimelineQueryDto,
} from './dto/device-detail.dto.js';
import { DeviceListDto, DeviceListItemDto, DeviceQueryDto } from './dto/device-query.dto.js';

/**
 * Abbildung der sortierbaren Felder auf Spalten. Der Wert landet unmaskiert in
 * `ORDER BY`, darf also niemals direkt aus der Anfrage stammen — deshalb diese
 * feste Tabelle statt einer Umwandlung.
 *
 * `patchAgeDays` sortiert absichtlich ueber den Zeitstempel und dreht die
 * Richtung um: je aelter das aelteste offene Update, desto groesser das
 * Patch-Alter.
 */
const SORT_COLUMNS: Record<string, { column: string; invert?: boolean }> = {
  hostname: { column: 'd.hostname' },
  lastSeenAt: { column: 'd.last_seen_at' },
  osBuild: { column: 'd.os_build' },
  openUpdates: { column: 'open_updates' },
  openSecurityUpdates: { column: 'open_security_updates' },
  patchAgeDays: { column: 'o.oldest_open_at', invert: true },
  updateSource: { column: 'c.update_source' },
};

interface DeviceRow {
  id: string;
  hostname: string;
  ad_ou: string | null;
  os_name: string | null;
  os_version: string | null;
  os_build: string | null;
  status: DeviceStatus;
  agent_version: string | null;
  enrolled_at: Date | null;
  last_seen_at: Date | null;
  update_source: UpdateSource | null;
  pending_reboot: boolean;
  open_updates: string;
  open_security_updates: string;
  patch_age_days: number | null;
}

@Injectable()
export class DevicesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Die beiden abgeleiteten Groessen — offene Updates und Patch-Alter — kommen
   * aus gemeinsamen Tabellenausdruecken statt aus Unterabfragen je Zeile. Bei
   * einer Flotte im vierstelligen Bereich ist das der Unterschied zwischen
   * einer und mehreren Sekunden.
   */
  private static readonly ANNOTATED_DEVICES = `
    WITH open_states AS (
      SELECT s.device_id,
             count(*)                                  AS open_updates,
             count(*) FILTER (WHERE u.is_security)     AS open_security_updates,
             min(s.first_available_at)                 AS oldest_open_at
        FROM device_update_states s
        JOIN updates u ON u.id = s.update_id
       WHERE s.state = 'available'
       GROUP BY s.device_id
    ),
    latest_checkin AS (
      SELECT DISTINCT ON (device_id)
             device_id, update_source, pending_reboot
        FROM device_checkins
       ORDER BY device_id, collected_at DESC
    )
  `;

  async list(query: DeviceQueryDto): Promise<DeviceListDto> {
    const params = new SqlParams();
    const where = this.buildWhere(query, params);

    const sort = SORT_COLUMNS[query.sortBy] ?? SORT_COLUMNS.hostname;
    const direction = sort.invert
      ? query.sortDir === 'asc'
        ? 'DESC'
        : 'ASC'
      : query.sortDir === 'asc'
        ? 'ASC'
        : 'DESC';

    const limit = params.add(query.limit);
    const offset = params.add((query.page - 1) * query.limit);

    const rows: DeviceRow[] = await this.dataSource.query(
      `${DevicesService.ANNOTATED_DEVICES}
       SELECT d.id, d.hostname, d.ad_ou, d.os_name, d.os_version, d.os_build, d.status,
              d.agent_version, d.enrolled_at, d.last_seen_at,
              c.update_source,
              coalesce(c.pending_reboot, false)     AS pending_reboot,
              coalesce(o.open_updates, 0)           AS open_updates,
              coalesce(o.open_security_updates, 0)  AS open_security_updates,
              date_part('day', now() - o.oldest_open_at)::int AS patch_age_days
         FROM devices d
         LEFT JOIN open_states    o ON o.device_id = d.id
         LEFT JOIN latest_checkin c ON c.device_id = d.id
        ${where}
        ORDER BY ${sort.column} ${direction} NULLS LAST, d.hostname ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params.values,
    );

    // Eigene Parameterliste: die Zaehlung kennt weder LIMIT noch OFFSET.
    const countParams = new SqlParams();
    const countWhere = this.buildWhere(query, countParams);
    const countRows: Array<{ total: string }> = await this.dataSource.query(
      `${DevicesService.ANNOTATED_DEVICES}
       SELECT count(*)::text AS total
         FROM devices d
         LEFT JOIN open_states    o ON o.device_id = d.id
         LEFT JOIN latest_checkin c ON c.device_id = d.id
        ${countWhere}`,
      countParams.values,
    );

    return {
      items: rows.map((row) => this.toListItem(row)),
      total: Number(countRows[0]?.total ?? 0),
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Export der gefilterten Menge, nicht der angezeigten Seite.
   *
   * Die Obergrenze von 50 000 Zeilen ist kein Schoenheitsfehler: Der Export
   * baut die gesamte Datei im Speicher auf, und eine unbegrenzte Abfrage waere
   * bei einer grossen Flotte ein Weg, das Backend umzubringen.
   */
  async exportCsv(query: DeviceQueryDto): Promise<string> {
    const full: DeviceQueryDto = { ...query, page: 1, limit: 50_000 };
    const { items } = await this.list(full);

    return toCsv(
      [
        'Hostname',
        'OU',
        'Status',
        'Betriebssystem',
        'Version',
        'Build',
        'Update-Quelle',
        'Offene Updates',
        'davon Sicherheit',
        'Patch-Alter (Tage)',
        'Neustart ausstehend',
        'Agent-Version',
        'Registriert',
        'Letzter Check-in',
      ],
      items.map((item) => [
        item.hostname,
        item.adOu,
        item.status,
        item.osName,
        item.osVersion,
        item.osBuild,
        item.updateSource,
        item.openUpdates,
        item.openSecurityUpdates,
        item.patchAgeDays,
        item.pendingReboot ? 'ja' : 'nein',
        item.agentVersion,
        item.enrolledAt,
        item.lastSeenAt,
      ]),
    );
  }

  private buildWhere(query: DeviceQueryDto, params: SqlParams): string {
    const conditions: string[] = [];

    if (query.search) {
      const term = params.add(`%${query.search}%`);
      conditions.push(`(d.hostname ILIKE ${term} OR d.ad_ou ILIKE ${term})`);
    }

    if (query.status) {
      conditions.push(`d.status = ${params.add(query.status)}`);
    }

    if (query.updateSource) {
      conditions.push(`c.update_source = ${params.add(query.updateSource)}`);
    }

    if (query.staleDays !== undefined) {
      // Nur registrierte Geraete koennen "stumm" sein. Ein Geraet ohne Agent
      // gehoert in den Report "ohne Agent", nicht in "meldet sich nicht mehr" —
      // sonst vermischen sich zwei verschiedene Probleme.
      const days = params.add(query.staleDays);
      conditions.push(
        `d.enrolled_at IS NOT NULL
         AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - make_interval(days => ${days}))`,
      );
    }

    if (query.pendingReboot !== undefined) {
      conditions.push(`coalesce(c.pending_reboot, false) = ${params.add(query.pendingReboot)}`);
    }

    if (query.hasOpenSecurity) {
      conditions.push('coalesce(o.open_security_updates, 0) > 0');
    }

    if (query.withoutAgent) {
      conditions.push('d.enrolled_at IS NULL');
    }

    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  }

  private toListItem(row: DeviceRow): DeviceListItemDto {
    return {
      id: row.id,
      hostname: row.hostname,
      adOu: row.ad_ou,
      osName: row.os_name,
      osVersion: row.os_version,
      osBuild: row.os_build,
      status: row.status,
      agentVersion: row.agent_version,
      enrolledAt: row.enrolled_at?.toISOString() ?? null,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      updateSource: row.update_source,
      pendingReboot: row.pending_reboot,
      // count() liefert bigint, der Treiber gibt es als Zeichenkette zurueck.
      openUpdates: Number(row.open_updates),
      openSecurityUpdates: Number(row.open_security_updates),
      patchAgeDays: row.patch_age_days,
    };
  }

  async detail(id: string): Promise<DeviceDetailDto> {
    const devices: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT id, hostname, ad_dn, ad_ou, ad_object_guid, os_name, os_version, os_build,
              status, agent_version, enrolled_at, last_seen_at, archived_at, archived_reason
         FROM devices WHERE id = $1`,
      [id],
    );

    const device = devices[0];
    if (!device) {
      throw new NotFoundException('Geraet nicht gefunden.');
    }

    const [updates, checkins] = await Promise.all([
      this.deviceUpdates(id),
      this.deviceCheckins(id),
    ]);

    return {
      id: device.id as string,
      hostname: device.hostname as string,
      adDn: (device.ad_dn as string | null) ?? null,
      adOu: (device.ad_ou as string | null) ?? null,
      adObjectGuid: (device.ad_object_guid as string | null) ?? null,
      osName: (device.os_name as string | null) ?? null,
      osVersion: (device.os_version as string | null) ?? null,
      osBuild: (device.os_build as string | null) ?? null,
      status: device.status as DeviceStatus,
      agentVersion: (device.agent_version as string | null) ?? null,
      enrolledAt: toIso(device.enrolled_at),
      lastSeenAt: toIso(device.last_seen_at),
      archivedAt: toIso(device.archived_at),
      archivedReason: (device.archived_reason as string | null) ?? null,
      updates,
      checkins,
    };
  }

  private async deviceUpdates(deviceId: string): Promise<DeviceUpdateDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT u.id, u.update_id, u.kb_article, u.title, u.severity, u.categories,
              u.is_security, u.size_bytes, u.support_url,
              s.state, s.first_available_at, s.installed_at, s.result_code, s.hresult,
              s.reboot_required, s.last_reported_at
         FROM device_update_states s
         JOIN updates u ON u.id = s.update_id
        WHERE s.device_id = $1
        ORDER BY
          -- Offenes zuerst, danach Gescheitertes: das ist die Reihenfolge, in
          -- der jemand die Seite liest, der ein Problem sucht.
          CASE s.state
            WHEN 'available' THEN 0
            WHEN 'failed'    THEN 1
            WHEN 'installed' THEN 2
            ELSE 3
          END,
          u.is_security DESC,
          s.first_available_at ASC NULLS LAST,
          u.title ASC`,
      [deviceId],
    );

    return rows.map((row) => ({
      updateId: row.id as string,
      wuUpdateId: row.update_id as string,
      kbArticle: (row.kb_article as string | null) ?? null,
      title: row.title as string,
      severity: (row.severity as string | null) ?? null,
      categories: (row.categories as string[] | null) ?? [],
      isSecurity: row.is_security as boolean,
      sizeBytes: (row.size_bytes as string | null) ?? null,
      supportUrl: (row.support_url as string | null) ?? null,
      state: row.state as UpdateState,
      firstAvailableAt: toIso(row.first_available_at),
      installedAt: toIso(row.installed_at),
      resultCode: (row.result_code as number | null) ?? null,
      hresult: (row.hresult as number | null) ?? null,
      rebootRequired: row.reboot_required as boolean,
      lastReportedAt: toIso(row.last_reported_at) ?? '',
    }));
  }

  private async deviceCheckins(deviceId: string): Promise<DeviceCheckinDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT id, collected_at, reported_at, agent_version, update_source,
              wsus_server_url, pending_reboot
         FROM device_checkins
        WHERE device_id = $1
        ORDER BY collected_at DESC
        LIMIT 20`,
      [deviceId],
    );

    return rows.map((row) => ({
      id: row.id as string,
      collectedAt: toIso(row.collected_at) ?? '',
      reportedAt: toIso(row.reported_at) ?? '',
      agentVersion: (row.agent_version as string | null) ?? null,
      updateSource: row.update_source as UpdateSource,
      wsusServerUrl: (row.wsus_server_url as string | null) ?? null,
      pendingReboot: row.pending_reboot as boolean,
    }));
  }

  /**
   * Archiviert bzw. reaktiviert von Hand.
   *
   * Geloescht wird nie — auch hier nicht. Ein ausgemustertes Geraet behaelt
   * seine Historie, damit Auswertungen ueber vergangene Zeitraeume stimmen.
   *
   * Zu beachten: Steht das Geraet weiterhin im AD, holt der naechste Abgleich
   * es wieder zurueck. Das ist gewollt — das AD ist die fuehrende Quelle.
   */
  async setArchived(id: string, archived: boolean, reason: string | null): Promise<DeviceDetailDto> {
    const result: Array<{ id: string }> = await this.dataSource.query(
      `UPDATE devices SET
         status          = $2,
         archived_at     = CASE WHEN $2 = 'archived' THEN now() ELSE NULL END,
         archived_reason = CASE WHEN $2 = 'archived' THEN $3 ELSE NULL END,
         updated_at      = now()
       WHERE id = $1
       RETURNING id`,
      [id, archived ? DeviceStatus.Archived : DeviceStatus.Active, reason],
    );

    if (result.length === 0) {
      throw new NotFoundException('Geraet nicht gefunden.');
    }

    return this.detail(id);
  }

  async timeline(deviceId: string, query: TimelineQueryDto): Promise<TimelineDto> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT e.id::text AS id, e.event_type, e.occurred_at, e.reported_at, e.details,
              u.kb_article, u.title, u.is_security
         FROM device_update_events e
         JOIN updates u ON u.id = e.update_id
        WHERE e.device_id = $1
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT $2 OFFSET $3`,
      [deviceId, query.limit, query.offset],
    );

    const totals: Array<{ total: string }> = await this.dataSource.query(
      'SELECT count(*)::text AS total FROM device_update_events WHERE device_id = $1',
      [deviceId],
    );

    const items: TimelineEntryDto[] = rows.map((row) => ({
      id: row.id as string,
      eventType: row.event_type as UpdateEventType,
      occurredAt: toIso(row.occurred_at) ?? '',
      reportedAt: toIso(row.reported_at) ?? '',
      kbArticle: (row.kb_article as string | null) ?? null,
      title: row.title as string,
      isSecurity: row.is_security as boolean,
      details: (row.details as Record<string, unknown> | null) ?? null,
    }));

    return { items, total: Number(totals[0]?.total ?? 0) };
  }
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
