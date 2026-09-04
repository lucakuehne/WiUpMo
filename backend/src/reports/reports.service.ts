import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UpdateSource } from '../database/enums.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  ComplianceDeviceDto,
  FailureGroupDto,
  MissingAgentDto,
  PatchAgeReportDto,
  StaleAgentDto,
  SummaryDto,
  TimeToPatchDto,
  TrendPointDto,
  UpdateSourcesReportDto,
} from './dto/reports.dto.js';

/**
 * Wiederverwendete Bausteine.
 *
 * `open_states` und `latest_checkin` tauchen in fast jeder Auswertung auf. Sie
 * hier einmal zu definieren haelt die Abfragen lesbar und stellt sicher, dass
 * "offen" ueberall dasselbe bedeutet — sonst weichen die Kennzahlen auf dem
 * Dashboard von denen im Report ab, und niemand weiss, welche stimmt.
 */
const OPEN_STATES = `
  open_states AS (
    SELECT s.device_id,
           count(*)                              AS open_updates,
           count(*) FILTER (WHERE u.is_security) AS open_security_updates,
           min(s.first_available_at)             AS oldest_open_at,
           min(s.first_available_at) FILTER (WHERE u.is_security) AS oldest_security_open_at
      FROM device_update_states s
      JOIN updates u ON u.id = s.update_id
     WHERE s.state = 'available'
     GROUP BY s.device_id
  )
`;

const LATEST_CHECKIN = `
  latest_checkin AS (
    SELECT DISTINCT ON (device_id)
           device_id, update_source, pending_reboot, collected_at
      FROM device_checkins
     ORDER BY device_id, collected_at DESC
  )
`;

@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async summary(): Promise<SummaryDto> {
    const { staleAgentDays, criticalOpenDays } = await this.settings.getThresholds();

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH ${OPEN_STATES}, ${LATEST_CHECKIN}
       SELECT
         count(*)                                                           AS devices_total,
         count(*) FILTER (WHERE d.status = 'active')                        AS devices_active,
         count(*) FILTER (WHERE d.status = 'archived')                      AS devices_archived,
         count(*) FILTER (WHERE d.enrolled_at IS NOT NULL)                  AS devices_enrolled,
         count(*) FILTER (WHERE d.enrolled_at IS NULL AND d.status = 'active') AS devices_without_agent,
         count(*) FILTER (
           WHERE d.enrolled_at IS NOT NULL
             AND d.status = 'active'
             AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - make_interval(days => $1))
         )                                                                  AS stale_agents,
         count(*) FILTER (WHERE coalesce(o.open_security_updates, 0) > 0)   AS devices_with_open_security,
         count(*) FILTER (
           WHERE o.oldest_security_open_at < now() - make_interval(days => $2)
         )                                                                  AS devices_critical,
         count(*) FILTER (WHERE coalesce(c.pending_reboot, false))          AS devices_pending_reboot,
         coalesce(sum(o.open_updates), 0)                                   AS open_updates_total,
         coalesce(sum(o.open_security_updates), 0)                          AS open_security_total,
         -- Median statt Mittelwert: Ein einzelnes vergessenes Geraet mit
         -- 400 Tagen Patch-Alter wuerde einen Durchschnitt unbrauchbar machen.
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY date_part('day', now() - o.oldest_open_at)
         ) FILTER (WHERE o.oldest_open_at IS NOT NULL)                      AS median_patch_age
         FROM devices d
         LEFT JOIN open_states    o ON o.device_id = d.id
         LEFT JOIN latest_checkin c ON c.device_id = d.id`,
      [staleAgentDays, criticalOpenDays],
    );

    const row = rows[0] ?? {};

    return {
      devicesTotal: num(row.devices_total),
      devicesActive: num(row.devices_active),
      devicesArchived: num(row.devices_archived),
      devicesEnrolled: num(row.devices_enrolled),
      devicesWithoutAgent: num(row.devices_without_agent),
      staleAgents: num(row.stale_agents),
      devicesWithOpenSecurity: num(row.devices_with_open_security),
      devicesCritical: num(row.devices_critical),
      devicesPendingReboot: num(row.devices_pending_reboot),
      openUpdatesTotal: num(row.open_updates_total),
      openSecurityUpdatesTotal: num(row.open_security_total),
      medianPatchAgeDays: nullableNum(row.median_patch_age),
      staleAgentDays,
      criticalOpenDays,
    };
  }

  async compliance(): Promise<ComplianceDeviceDto[]> {
    const { criticalOpenDays } = await this.settings.getThresholds();

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH ${OPEN_STATES}, ${LATEST_CHECKIN}
       SELECT d.id, d.hostname, d.ad_ou, d.last_seen_at,
              coalesce(o.open_security_updates, 0) AS open_security_updates,
              date_part('day', now() - o.oldest_security_open_at)::int AS oldest_open_days,
              coalesce(c.pending_reboot, false) AS pending_reboot
         FROM devices d
         JOIN open_states o ON o.device_id = d.id
         LEFT JOIN latest_checkin c ON c.device_id = d.id
        WHERE d.status = 'active'
          AND o.oldest_security_open_at < now() - make_interval(days => $1)
        ORDER BY o.oldest_security_open_at ASC`,
      [criticalOpenDays],
    );

    return rows.map((row) => ({
      deviceId: row.id as string,
      hostname: row.hostname as string,
      adOu: (row.ad_ou as string | null) ?? null,
      openSecurityUpdates: num(row.open_security_updates),
      oldestOpenDays: nullableNum(row.oldest_open_days),
      lastSeenAt: iso(row.last_seen_at),
      pendingReboot: row.pending_reboot as boolean,
    }));
  }

  async patchAge(): Promise<PatchAgeReportDto> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH ${OPEN_STATES},
       aged AS (
         SELECT d.id,
                CASE
                  WHEN o.oldest_open_at IS NULL THEN 'none'
                  WHEN o.oldest_open_at > now() - interval '7 days'  THEN 'lt7'
                  WHEN o.oldest_open_at > now() - interval '14 days' THEN 'lt14'
                  WHEN o.oldest_open_at > now() - interval '30 days' THEN 'lt30'
                  WHEN o.oldest_open_at > now() - interval '90 days' THEN 'lt90'
                  ELSE 'ge90'
                END AS bucket
           FROM devices d
           LEFT JOIN open_states o ON o.device_id = d.id
          WHERE d.status = 'active' AND d.enrolled_at IS NOT NULL
       )
       SELECT bucket, count(*) AS devices FROM aged GROUP BY bucket`,
    );

    const counts = new Map(rows.map((row) => [row.bucket as string, num(row.devices)]));

    const osRows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT os_name, os_build, count(*) AS devices
         FROM devices
        WHERE status = 'active' AND enrolled_at IS NOT NULL
        GROUP BY os_name, os_build
        ORDER BY devices DESC, os_build DESC NULLS LAST`,
    );

    return {
      buckets: [
        { fromDays: null, toDays: null, label: 'nichts offen', devices: counts.get('none') ?? 0 },
        { fromDays: 0, toDays: 7, label: 'bis 7 Tage', devices: counts.get('lt7') ?? 0 },
        { fromDays: 7, toDays: 14, label: '7–14 Tage', devices: counts.get('lt14') ?? 0 },
        { fromDays: 14, toDays: 30, label: '14–30 Tage', devices: counts.get('lt30') ?? 0 },
        { fromDays: 30, toDays: 90, label: '30–90 Tage', devices: counts.get('lt90') ?? 0 },
        { fromDays: 90, toDays: null, label: 'über 90 Tage', devices: counts.get('ge90') ?? 0 },
      ],
      osBuilds: osRows.map((row) => ({
        osName: (row.os_name as string | null) ?? null,
        osBuild: (row.os_build as string | null) ?? null,
        devices: num(row.devices),
      })),
    };
  }

  async updateSources(): Promise<UpdateSourcesReportDto> {
    const distribution: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH ${OPEN_STATES}, ${LATEST_CHECKIN}
       SELECT coalesce(c.update_source, 'unknown') AS source,
              count(*) AS devices,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY date_part('day', now() - o.oldest_open_at)
              ) FILTER (WHERE o.oldest_open_at IS NOT NULL) AS median_patch_age
         FROM devices d
         LEFT JOIN latest_checkin c ON c.device_id = d.id
         LEFT JOIN open_states    o ON o.device_id = d.id
        WHERE d.status = 'active' AND d.enrolled_at IS NOT NULL
        GROUP BY coalesce(c.update_source, 'unknown')
        ORDER BY devices DESC`,
    );

    /**
     * Quellenwechsel: der jeweils letzte Check-in eines Geraets gegen den
     * davorliegenden. Das ist der Migrationsfortschritt — welche Geraete
     * tatsaechlich von WSUS weg sind, nicht welche laut Richtlinie sollten.
     */
    const changes: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH ranked AS (
         SELECT device_id, update_source, collected_at,
                row_number() OVER (PARTITION BY device_id ORDER BY collected_at DESC) AS rn
           FROM device_checkins
       )
       SELECT d.id, d.hostname,
              previous.update_source AS previous_source,
              current.update_source  AS current_source,
              current.collected_at   AS changed_at
         FROM ranked current
         JOIN ranked previous ON previous.device_id = current.device_id AND previous.rn = 2
         JOIN devices d ON d.id = current.device_id
        WHERE current.rn = 1
          AND current.update_source <> previous.update_source
        ORDER BY current.collected_at DESC
        LIMIT 100`,
    );

    return {
      distribution: distribution.map((row) => ({
        source: row.source as UpdateSource,
        devices: num(row.devices),
        medianPatchAgeDays: nullableNum(row.median_patch_age),
      })),
      changes: changes.map((row) => ({
        deviceId: row.id as string,
        hostname: row.hostname as string,
        previousSource: row.previous_source as UpdateSource,
        currentSource: row.current_source as UpdateSource,
        changedAt: iso(row.changed_at) ?? '',
      })),
    };
  }

  async staleAgents(): Promise<StaleAgentDto[]> {
    const { staleAgentDays } = await this.settings.getThresholds();

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT id, hostname, ad_ou, last_seen_at, agent_version,
              date_part('day', now() - last_seen_at)::int AS days_silent
         FROM devices
        WHERE status = 'active'
          AND enrolled_at IS NOT NULL
          AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(days => $1))
        ORDER BY last_seen_at ASC NULLS FIRST`,
      [staleAgentDays],
    );

    return rows.map((row) => ({
      deviceId: row.id as string,
      hostname: row.hostname as string,
      adOu: (row.ad_ou as string | null) ?? null,
      lastSeenAt: iso(row.last_seen_at),
      daysSilent: nullableNum(row.days_silent),
      agentVersion: (row.agent_version as string | null) ?? null,
    }));
  }

  /** Im AD bekannt, aber ohne Agent. Die Deployment-Luecke. */
  async missingAgents(): Promise<MissingAgentDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT id, hostname, ad_ou, os_name, ad_dn
         FROM devices
        WHERE status = 'active' AND enrolled_at IS NULL
        ORDER BY ad_ou NULLS LAST, hostname`,
    );

    return rows.map((row) => ({
      deviceId: row.id as string,
      hostname: row.hostname as string,
      adOu: (row.ad_ou as string | null) ?? null,
      osName: (row.os_name as string | null) ?? null,
      adDn: (row.ad_dn as string | null) ?? null,
    }));
  }

  /**
   * Zeit von "erstmals als verfuegbar gemeldet" bis "installiert", je
   * Einstufung. Nur Zustaende, in denen beide Zeitpunkte bekannt sind — bei
   * einem Geraet, das den Agent erst nach der Installation bekam, fehlt der
   * erste, und die Kennzahl waere frei erfunden.
   */
  async timeToPatch(): Promise<TimeToPatchDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT coalesce(nullif(u.severity, ''), CASE WHEN u.is_security THEN 'Sicherheit' ELSE 'ohne Einstufung' END) AS severity,
              count(*) AS updates,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY date_part('day', s.installed_at - s.first_available_at)
              ) AS median_days,
              percentile_cont(0.9) WITHIN GROUP (
                ORDER BY date_part('day', s.installed_at - s.first_available_at)
              ) AS p90_days
         FROM device_update_states s
         JOIN updates u ON u.id = s.update_id
        WHERE s.state = 'installed'
          AND s.installed_at IS NOT NULL
          AND s.first_available_at IS NOT NULL
          AND s.installed_at >= s.first_available_at
        GROUP BY 1
        ORDER BY updates DESC`,
    );

    return rows.map((row) => ({
      severity: row.severity as string,
      updates: num(row.updates),
      medianDays: nullableNum(row.median_days),
      p90Days: nullableNum(row.p90_days),
    }));
  }

  /** Wiederholt gescheiterte Installationen, nach Fehlercode gruppiert. */
  async failures(): Promise<FailureGroupDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT u.id, u.kb_article, u.title, s.hresult,
              count(DISTINCT s.device_id) AS devices,
              count(*) AS attempts
         FROM device_update_states s
         JOIN updates u ON u.id = s.update_id
        WHERE s.state = 'failed'
        GROUP BY u.id, u.kb_article, u.title, s.hresult
        ORDER BY devices DESC, attempts DESC
        LIMIT 100`,
    );

    return rows.map((row) => ({
      updateId: row.id as string,
      kbArticle: (row.kb_article as string | null) ?? null,
      title: row.title as string,
      hresult: (row.hresult as number | null) ?? null,
      devices: num(row.devices),
      attempts: num(row.attempts),
    }));
  }

  /**
   * Verlauf der offenen Updates.
   *
   * Es gibt keine Tagesmomentaufnahme in der Datenbank — der Plan sieht sie als
   * Option fuer spaeter vor. Der Verlauf wird deshalb aus dem heutigen Stand
   * rueckwaerts aus der Zeitreihe rekonstruiert: Was seither aufgetaucht ist,
   * wird abgezogen; was installiert oder verschwunden ist, hinzugerechnet.
   *
   * Die Rechnung stimmt, solange die Ereignisse im betrachteten Fenster
   * vollstaendig sind. Reicht die Anfrage weiter zurueck als die
   * Aufbewahrungsfrist, wird der aeltere Teil der Kurve zunehmend flach —
   * dann fehlen die Ereignisse, nicht die Updates.
   */
  async trend(days: number): Promise<TrendPointDto[]> {
    const current: Array<{ open: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS open FROM device_update_states WHERE state = 'available'`,
    );

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT date_trunc('day', occurred_at)::date AS day,
              count(*) FILTER (WHERE event_type = 'appeared')                        AS appeared,
              count(*) FILTER (WHERE event_type = 'installed')                       AS installed,
              count(*) FILTER (WHERE event_type IN ('installed', 'disappeared', 'hidden')) AS resolved
         FROM device_update_events
        WHERE occurred_at >= now() - make_interval(days => $1)
        GROUP BY 1
        ORDER BY 1`,
      [days],
    );

    const byDay = new Map(
      rows.map((row) => [
        (row.day as Date).toISOString().slice(0, 10),
        {
          appeared: num(row.appeared),
          installed: num(row.installed),
          resolved: num(row.resolved),
        },
      ]),
    );

    // Vom heutigen Stand rueckwaerts, danach wieder in zeitliche Reihenfolge.
    const points: TrendPointDto[] = [];
    let open = Number(current[0]?.open ?? 0);

    for (let offset = 0; offset < days; offset++) {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - offset);
      const key = date.toISOString().slice(0, 10);
      const events = byDay.get(key) ?? { appeared: 0, installed: 0, resolved: 0 };

      points.push({
        date: key,
        openUpdates: Math.max(0, open),
        appeared: events.appeared,
        installed: events.installed,
      });

      open = open - events.appeared + events.resolved;
    }

    return points.reverse();
  }
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
