import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isVersionAtLeast } from '../common/agent-version.js';
import { postRebootPendingSql } from '../common/post-reboot.js';
import { returnedRows } from '../common/query-result.js';
import {
  UPDATE_CLASSIFICATIONS,
  UpdateClassification,
  classificationSql,
} from '../common/update-classification.js';
import { DeviceStatus, InstallJobScope, InstallJobState } from '../database/enums.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  CreateInstallJobsDto,
  CreateInstallJobsResultDto,
  DEFAULT_SPREAD_MINUTES,
  InstallationCancelResultDto,
  InstallationListDto,
  InstallationStatesDto,
  InstallJobsSkippedDto,
  InstallPreviewDto,
  InstallJobUpdateResultDto,
  InstallJobViewDto,
  InstallRequestDto,
  InstallResultDto,
  InstallUpdateResultDto,
} from './dto/install-job.dto.js';

/** Ab dieser Version fuehrt der Agent Installationsauftraege aus. */
export const MIN_INSTALL_AGENT_VERSION = '0.7.0';

/**
 * Nach so vielen Stunden im Zustand `running` gilt ein Auftrag als
 * unterbrochen — sofern sich das Geraet seither gemeldet hat. Grosszuegig:
 * Ein Feature-Update braucht auf einem langsamen Rechner Stunden.
 */
const STALLED_AFTER_HOURS = 6;

/**
 * Welche offenen Updates zu einem Auftrag passen, als Bedingung ueber
 * `device_update_states s` und `updates u`. Die Platzhalter fuer Umfang,
 * Katalog-IDs und Typen werden mitgegeben, weil ihre Nummern je Abfrage
 * verschieden sind.
 *
 * Der Umfang steht als Parameter im SQL statt als eingesetzter Text: Alle
 * Platzhalter kommen so in jeder Abfrage vor. Fehlt einer, kann PostgreSQL
 * seinen Typ nicht bestimmen und bricht die ganze Abfrage ab.
 *
 * Was eingespielt ist und nur auf den Neustart wartet, passt nie — auch nicht,
 * wenn es ausdruecklich ausgewaehlt war.
 */
function scopeCondition(scope: string, ids: string, classes: string): string {
  return `NOT ${postRebootPendingSql('s')}
          AND CASE ${scope}::text
            WHEN '${InstallJobScope.Selected}' THEN s.update_id = ANY(${ids}::uuid[])
            ELSE ${classificationSql('u')} = ANY(${classes}::text[])
          END`;
}

@Injectable()
export class InstallJobsService {
  private readonly logger = new Logger(InstallJobsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {}

  // --- Anlegen ------------------------------------------------------------------

  /**
   * Legt je Geraet einen Auftrag an — soweit es einen bekommen kann.
   *
   * Uebergangen wird ein Geraet, das nicht aktiv ist oder keinen Agent hat,
   * dessen Agent zu alt ist, das schon einen offenen Auftrag hat oder bei dem
   * nichts zum Umfang Passendes offen ist. Die Antwort zaehlt die Gruende, damit
   * eine Mehrfachauswahl nicht stillschweigend schrumpft.
   */
  async create(dto: CreateInstallJobsDto, createdBy: string): Promise<CreateInstallJobsResultDto> {
    const selected = dto.scope === InstallJobScope.Selected;
    const updateIds = selected ? (dto.updateIds ?? []) : [];
    const classifications = selected ? [] : [...new Set(dto.classifications ?? [])];
    if (selected && updateIds.length === 0) {
      throw new BadRequestException('Bei "ausgewaehlte Updates" muss mindestens ein Update gewaehlt sein.');
    }
    if (!selected && classifications.length === 0) {
      throw new BadRequestException('Mindestens ein Update-Typ muss gewaehlt sein.');
    }

    const deviceIds = [...new Set(dto.deviceIds)];
    const devices: Array<{
      id: string;
      status: DeviceStatus;
      enrolled: boolean;
      agent_version: string | null;
      open_job: boolean;
      matching: string;
    }> = await this.dataSource.query(
      `SELECT d.id, d.status, d.enrolled_at IS NOT NULL AS enrolled, d.agent_version,
              EXISTS (
                SELECT 1 FROM update_install_jobs j
                 WHERE j.device_id = d.id AND j.state IN ('pending', 'delivered', 'running')
              ) AS open_job,
              (SELECT count(*) FROM device_update_states s JOIN updates u ON u.id = s.update_id
                WHERE s.device_id = d.id AND s.state = 'available'
                  AND ${scopeCondition('$3', '$2', '$4')})::text AS matching
         FROM devices d
        WHERE d.id = ANY($1::uuid[])`,
      [deviceIds, updateIds, dto.scope, classifications],
    );

    const skipped = { openJob: 0, agentTooOld: 0, notEligible: deviceIds.length - devices.length, nothingOpen: 0 };
    const eligible: string[] = [];

    for (const device of devices) {
      if (device.status !== DeviceStatus.Active || !device.enrolled) skipped.notEligible++;
      else if (!isVersionAtLeast(device.agent_version, MIN_INSTALL_AGENT_VERSION)) skipped.agentTooOld++;
      else if (device.open_job) skipped.openJob++;
      else if (Number(device.matching) === 0) skipped.nothingOpen++;
      else eligible.push(device.id);
    }

    const { expiryDays } = await this.settings.getInstall();
    const requested = dto.notBefore ? new Date(dto.notBefore).getTime() : Date.now();
    const start = Math.max(requested, Date.now());
    // Bei einem einzelnen Geraet gibt es nichts zu entzerren.
    const spreadMinutes = eligible.length > 1 ? (dto.spreadMinutes ?? DEFAULT_SPREAD_MINUTES) : 0;
    const notBefore = eligible.map((): string =>
      new Date(start + Math.floor(Math.random() * spreadMinutes * 60_000)).toISOString(),
    );

    // In einem Zug: Eine Installation gibt es nur mit mindestens einem Auftrag.
    let created = 0;
    const installationId = await this.dataSource.transaction(async (manager): Promise<string | null> => {
      if (eligible.length === 0) return null;

      const [installation] = (await manager.query(
        `INSERT INTO update_installations
           (scope, update_ids, classifications, not_before, spread_minutes, requested_devices, created_by)
         VALUES ($1, $2::uuid[], $3::text[], $4, $5, $6, $7)
         RETURNING id`,
        [dto.scope, updateIds, classifications, new Date(start), spreadMinutes, deviceIds.length, createdBy],
      )) as Array<{ id: string }>;

      // ON CONFLICT: Ein gleichzeitiger zweiter Auftrag prallt am Index ab,
      // statt als Fehler zu enden. Die Frist in Sekunden, damit ein Wechsel
      // der Sommerzeit sie nicht um eine Stunde verschiebt.
      const rows: unknown[] = await manager.query(
        `INSERT INTO update_install_jobs
           (installation_id, device_id, scope, update_ids, classifications, not_before, expires_at, created_by)
         SELECT $1, t.device_id, $2, $3::uuid[], $4::text[], t.not_before,
                t.not_before + make_interval(secs => $5::int * 86400), $6
           FROM unnest($7::uuid[], $8::timestamptz[]) AS t(device_id, not_before)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [installation.id, dto.scope, updateIds, classifications, expiryDays, createdBy, eligible, notBefore],
      );
      created = rows.length;
      skipped.openJob += eligible.length - created;

      if (created === 0) {
        await manager.query('DELETE FROM update_installations WHERE id = $1', [installation.id]);
        return null;
      }

      await manager.query('UPDATE update_installations SET skipped = $2::jsonb WHERE id = $1', [
        installation.id,
        JSON.stringify(skipped),
      ]);
      return installation.id;
    });

    this.logger.log(
      `${created} Installationsauftrag/-auftraege (${dto.scope}) von ${createdBy} angelegt, ` +
        `${deviceIds.length - created} uebergangen.`,
    );

    return { installationId, created, skipped, expiryDays, minimumAgentVersion: MIN_INSTALL_AGENT_VERSION };
  }

  /**
   * Was je Typ auf den gewaehlten Geraeten offen ist — fuer die Kaestchen im
   * Dialog. Alle Typen kommen mit, auch die ohne Treffer, damit die Liste
   * nicht je nach Auswahl springt.
   */
  async preview(deviceIds: string[]): Promise<InstallPreviewDto> {
    const rows: Array<{ classification: UpdateClassification; updates: string; devices: string }> =
      await this.dataSource.query(
        `SELECT ${classificationSql('u')} AS classification,
                count(DISTINCT u.id)::text AS updates, count(DISTINCT s.device_id)::text AS devices
           FROM device_update_states s JOIN updates u ON u.id = s.update_id
          WHERE s.device_id = ANY($1::uuid[]) AND s.state = 'available'
            AND NOT ${postRebootPendingSql('s')}
          GROUP BY 1`,
        [[...new Set(deviceIds)]],
      );

    const counts = new Map(rows.map((row) => [row.classification, row]));
    return {
      classifications: UPDATE_CLASSIFICATIONS.map((classification) => ({
        classification,
        updates: Number(counts.get(classification)?.updates ?? 0),
        devices: Number(counts.get(classification)?.devices ?? 0),
      })),
    };
  }

  // --- Protokoll ----------------------------------------------------------------

  /**
   * Die Auftraege eines Geraets oder einer Installation, neueste zuerst. Die
   * einer Installation sind gleich alt und stehen nach Hostname.
   */
  async list(
    limit: number,
    filter: { deviceId?: string; installationId?: string } = {},
  ): Promise<InstallJobViewDto[]> {
    await this.cleanup(filter.deviceId);

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT j.id, j.installation_id, j.device_id, d.hostname, j.scope,
              cardinality(j.update_ids) AS selected_count, j.classifications, j.state, j.not_before,
              j.expires_at, j.created_by, j.created_at, j.delivered_at, j.started_at, j.completed_at,
              j.result, j.error
         FROM update_install_jobs j
         JOIN devices d ON d.id = j.device_id
        WHERE ($2::uuid IS NULL OR j.device_id = $2)
          AND ($3::uuid IS NULL OR j.installation_id = $3)
        ORDER BY j.created_at DESC, d.hostname ASC
        LIMIT $1`,
      [limit, filter.deviceId ?? null, filter.installationId ?? null],
    );

    const titles = await this.catalogTitles(rows);

    return rows.map((row) => ({
      id: row.id as string,
      installationId: row.installation_id as string,
      deviceId: row.device_id as string,
      hostname: row.hostname as string,
      scope: row.scope as InstallJobScope,
      selectedCount: Number(row.selected_count),
      classifications: (row.classifications as UpdateClassification[] | null) ?? [],
      state: row.state as InstallJobState,
      notBefore: iso(row.not_before) ?? '',
      expiresAt: iso(row.expires_at) ?? '',
      createdBy: row.created_by as string,
      createdAt: iso(row.created_at) ?? '',
      deliveredAt: iso(row.delivered_at),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      error: (row.error as string | null) ?? null,
      results: Array.isArray(row.result)
        ? (row.result as InstallUpdateResultDto[]).map((r): InstallJobUpdateResultDto => ({
            updateId: r.updateId,
            kbArticle: titles.get(r.updateId)?.kb ?? null,
            title: titles.get(r.updateId)?.title ?? null,
            offered: r.offered,
            resultCode: r.resultCode ?? null,
            hresult: r.hresult ?? null,
            rebootRequired: r.rebootRequired ?? false,
          }))
        : null,
    }));
  }

  /** Titel und KB zu den WU-IDs aus den Ergebnissen — der Agent meldet nur die ID. */
  private async catalogTitles(
    rows: Array<Record<string, unknown>>,
  ): Promise<Map<string, { title: string; kb: string | null }>> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          Array.isArray(row.result) ? (row.result as InstallUpdateResultDto[]).map((r) => r.updateId) : [],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();

    const catalog: Array<{ update_id: string; title: string; kb_article: string | null }> =
      await this.dataSource.query(
        'SELECT update_id, title, kb_article FROM updates WHERE update_id = ANY($1::text[])',
        [ids],
      );
    return new Map(catalog.map((u) => [u.update_id, { title: u.title, kb: u.kb_article }]));
  }

  async cancel(id: string): Promise<void> {
    const cancelled = returnedRows(
      await this.dataSource.query(
        `UPDATE update_install_jobs SET state = 'cancelled', completed_at = now(),
                error = 'Von Hand abgebrochen.'
          WHERE id = $1 AND state IN ('pending', 'delivered')
          RETURNING id`,
        [id],
      ),
    );
    if (cancelled.length > 0) return;

    const exists: unknown[] = await this.dataSource.query('SELECT 1 FROM update_install_jobs WHERE id = $1', [id]);
    if (exists.length === 0) throw new NotFoundException('Auftrag nicht gefunden.');
    throw new ConflictException('Der Auftrag laeuft bereits oder ist abgeschlossen.');
  }

  // --- Installationen -----------------------------------------------------------

  /**
   * Die Installationen, neueste zuerst, mit ihren Auftraegen je Zustand und
   * dem, was die Agents zurueckgemeldet haben.
   *
   * Gezaehlt wird wie in der Geraeteansicht: Installiert ist, was mit
   * Ergebniscode 2 oder 3 endete; was angeboten, aber nicht installiert wurde,
   * gilt als gescheitert.
   */
  async listInstallations(page: number, limit: number): Promise<InstallationListDto> {
    await this.cleanup();

    const states = Object.values(InstallJobState);
    const stateCounts = states
      .map((state) => `count(j.id) FILTER (WHERE j.state = '${state}')::int AS "state_${state}"`)
      .join(',\n              ');

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT i.id, i.scope, cardinality(i.update_ids) AS selected_count, i.classifications,
              i.not_before, i.spread_minutes, i.requested_devices, i.skipped, i.created_by, i.created_at,
              count(j.id)::int AS devices,
              ${stateCounts},
              coalesce(sum(r.installed), 0)::int AS installed_updates,
              coalesce(sum(r.failed), 0)::int AS failed_updates,
              count(j.id) FILTER (WHERE r.reboot)::int AS reboot_devices,
              max(j.completed_at) AS last_completed_at
         FROM update_installations i
         LEFT JOIN update_install_jobs j ON j.installation_id = i.id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE e.offered AND e.ok) AS installed,
                  count(*) FILTER (WHERE e.offered AND NOT e.ok) AS failed,
                  coalesce(bool_or(e.reboot), false) AS reboot
             FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(j.result) = 'array' THEN j.result ELSE '[]'::jsonb END
                  ) AS x(item)
            CROSS JOIN LATERAL (
              SELECT coalesce((x.item->>'offered')::boolean, false) AS offered,
                     coalesce((x.item->>'resultCode')::int IN (2, 3), false) AS ok,
                     coalesce((x.item->>'rebootRequired')::boolean, false) AS reboot
            ) AS e
         ) r ON true
        GROUP BY i.id
        ORDER BY i.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );

    const totals: Array<{ total: number }> = await this.dataSource.query(
      'SELECT count(*)::int AS total FROM update_installations',
    );

    return {
      items: rows.map((row) => ({
        id: row.id as string,
        scope: row.scope as InstallJobScope,
        selectedCount: Number(row.selected_count),
        classifications: (row.classifications as UpdateClassification[] | null) ?? [],
        notBefore: iso(row.not_before) ?? '',
        spreadMinutes: Number(row.spread_minutes),
        requestedDevices: Number(row.requested_devices),
        skipped: (row.skipped as InstallJobsSkippedDto | null) ?? null,
        createdBy: row.created_by as string,
        createdAt: iso(row.created_at) ?? '',
        devices: Number(row.devices),
        states: Object.fromEntries(
          states.map((state) => [state, Number(row[`state_${state}`])]),
        ) as unknown as InstallationStatesDto,
        installedUpdates: Number(row.installed_updates),
        failedUpdates: Number(row.failed_updates),
        rebootDevices: Number(row.reboot_devices),
        lastCompletedAt: iso(row.last_completed_at),
      })),
      total: Number(totals[0]?.total ?? 0),
      page,
      limit,
    };
  }

  /** Die Auftraege einer Installation, ein Geraet je Zeile. */
  async installationJobs(installationId: string): Promise<InstallJobViewDto[]> {
    await this.requireInstallation(installationId);
    return this.list(5000, { installationId });
  }

  /**
   * Bricht ab, was von einer Installation noch nicht laeuft. Laufende und
   * abgeschlossene Auftraege bleiben, wie sie sind — die Installation ist
   * danach nicht "abgebrochen", sie hat schlicht nichts Offenes mehr.
   */
  async cancelInstallation(installationId: string): Promise<InstallationCancelResultDto> {
    await this.requireInstallation(installationId);

    const cancelled = returnedRows(
      await this.dataSource.query(
        `UPDATE update_install_jobs SET state = 'cancelled', completed_at = now(),
                error = 'Von Hand abgebrochen.'
          WHERE installation_id = $1 AND state IN ('pending', 'delivered')
          RETURNING id`,
        [installationId],
      ),
    );

    if (cancelled.length > 0) {
      this.logger.log(`Installation ${installationId}: ${cancelled.length} Auftrag/Auftraege abgebrochen.`);
    }
    return { cancelled: cancelled.length };
  }

  private async requireInstallation(installationId: string): Promise<void> {
    const exists: unknown[] = await this.dataSource.query(
      'SELECT 1 FROM update_installations WHERE id = $1',
      [installationId],
    );
    if (exists.length === 0) throw new NotFoundException('Installation nicht gefunden.');
  }

  // --- Agent --------------------------------------------------------------------

  /**
   * Holt den faelligen Auftrag eines Geraets fuer die Check-in-Antwort.
   *
   * Nur fuer Agents ab 0.7.0 und erst ab `not_before` — der Agent braucht so
   * keine eigene Zeitsteuerung: Was er bekommt, ist faellig. Ein ausgelieferter
   * Auftrag geht bis zum Start erneut mit, falls die erste Antwort verloren
   * ging; ab `running` nicht mehr, sonst finge der Agent ihn zweimal an.
   *
   * Die Updates werden gegen die zuletzt gemeldete Verfuegbar-Liste
   * aufgeloest. Ist davon nichts mehr offen, ist der Auftrag erledigt, bevor
   * er hinausgeht.
   */
  async claim(deviceId: string, agentVersion: string | null): Promise<InstallRequestDto | null> {
    if (!isVersionAtLeast(agentVersion, MIN_INSTALL_AGENT_VERSION)) {
      return null;
    }

    await this.cleanup(deviceId);

    const jobs = returnedRows<{
      id: string;
      scope: InstallJobScope;
      update_ids: string[];
      classifications: string[];
    }>(
      await this.dataSource.query(
        `UPDATE update_install_jobs SET
           state        = 'delivered',
           delivered_at = coalesce(delivered_at, now())
         WHERE id = (
           SELECT id FROM update_install_jobs
            WHERE device_id = $1 AND state IN ('pending', 'delivered')
              AND not_before <= now() AND expires_at > now()
            ORDER BY created_at
            LIMIT 1
         )
         RETURNING id, scope, update_ids, classifications`,
        [deviceId],
      ),
    );

    const job = jobs[0];
    if (!job) return null;

    const updates: Array<{ update_id: string }> = await this.dataSource.query(
      `SELECT u.update_id
         FROM device_update_states s JOIN updates u ON u.id = s.update_id
        WHERE s.device_id = $1 AND s.state = 'available'
          AND ${scopeCondition('$3', '$2', '$4')}
        ORDER BY u.update_id`,
      [deviceId, job.update_ids ?? [], job.scope, job.classifications ?? []],
    );

    if (updates.length === 0) {
      await this.dataSource.query(
        `UPDATE update_install_jobs SET state = 'done', completed_at = now(), result = '[]'::jsonb,
                error = 'Nichts mehr zu installieren: Die Updates sind inzwischen installiert oder werden nicht mehr angeboten.'
          WHERE id = $1`,
        [job.id],
      );
      return null;
    }

    return { jobId: job.id, updateIds: updates.map((u) => u.update_id) };
  }

  /** Rueckmeldung des Agents. Nur eigene Auftraege, damit kein Geraet fremde schliesst. */
  async reportResult(deviceId: string, dto: InstallResultDto): Promise<void> {
    const terminal = dto.state !== 'running';

    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE update_install_jobs SET
           state        = $3::install_job_state,
           started_at   = coalesce(started_at, now()),
           completed_at = CASE WHEN $4 THEN now() ELSE completed_at END,
           result       = coalesce($5::jsonb, result),
           error        = $6
         WHERE id = $1 AND device_id = $2 AND state IN ('delivered', 'running')
         RETURNING id`,
        [
          dto.jobId,
          deviceId,
          dto.state,
          terminal,
          dto.results ? JSON.stringify(dto.results) : null,
          dto.error ?? null,
        ],
      ),
    );

    if (rows.length === 0) {
      throw new NotFoundException('Auftrag nicht gefunden oder nicht mehr offen.');
    }

    if (dto.state === 'failed') {
      this.logger.warn(`Installation auf Geraet ${deviceId} gescheitert: ${dto.error ?? 'ohne Angabe'}`);
    }
  }

  // --- Aufraeumen ---------------------------------------------------------------

  /**
   * Schliesst, was nicht mehr kommen wird: Auftraege, die bis zur Frist nicht
   * abgeholt wurden, und solche, die seit Stunden laufen, obwohl sich das
   * Geraet seither gemeldet hat — dann ist der Agent mittendrin neu gestartet.
   *
   * Laeuft beim Ausliefern und beim Lesen des Protokolls. Einen eigenen
   * Zeitgeber braucht es nicht: Ein Auftrag, den niemand ansieht und den kein
   * Geraet abholt, darf auch etwas spaeter als abgelaufen gelten.
   */
  private async cleanup(deviceId?: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE update_install_jobs SET state = 'expired', completed_at = now()
        WHERE state IN ('pending', 'delivered') AND expires_at <= now()
          AND ($1::uuid IS NULL OR device_id = $1)`,
      [deviceId ?? null],
    );

    await this.dataSource.query(
      `UPDATE update_install_jobs j SET state = 'failed', completed_at = now(),
              error = 'Unterbrochen: Das Geraet meldet sich, die Installation kam aber nicht zum Abschluss.'
        WHERE j.state = 'running'
          AND j.started_at < now() - make_interval(hours => $2::int)
          AND ($1::uuid IS NULL OR j.device_id = $1)
          AND EXISTS (
            SELECT 1 FROM devices d
             WHERE d.id = j.device_id
               AND d.last_seen_at > j.started_at + make_interval(hours => $2::int)
          )`,
      [deviceId ?? null, STALLED_AFTER_HOURS],
    );
  }
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
