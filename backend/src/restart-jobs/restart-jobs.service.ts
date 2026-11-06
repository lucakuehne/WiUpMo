import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isVersionAtLeast } from '../common/agent-version.js';
import { returnedRows } from '../common/query-result.js';
import { DeviceStatus, RestartJobState } from '../database/enums.js';
import { SettingsService } from '../settings/settings.service.js';
import { RestartSettings, promptTextFrom } from '../settings/settings.types.js';
import {
  CreateRestartJobsDto,
  CreateRestartJobsResultDto,
  RestartEventDto,
  RestartJobViewDto,
  RestartRequestDto,
  RestartRequestListDto,
  RestartResultDto,
  RestartRulesDto,
} from './dto/restart-job.dto.js';

/** Ab dieser Version fuehrt der Agent Neustart-Auftraege aus. */
export const MIN_RESTART_AGENT_VERSION = '0.9.0';

/** Noch nicht abgeschlossen; hoechstens einer davon je Geraet. */
const OPEN = `('pending', 'delivered', 'notified', 'deferred', 'restarting')`;

/** Was sich abbrechen laesst: alles Offene, nur nicht der eingeleitete Neustart. */
const CANCELLABLE = `('pending', 'delivered', 'notified', 'deferred')`;

/**
 * Erledigt, sobald das Geraet einen Neustart danach meldet. Verglichen wird mit
 * dem Zeitpunkt, zu dem der Agent ihn einleitete — beides von der Uhr des
 * Geraets. Startet der Benutzer vorher selbst neu, zaehlt die Anlage des
 * Auftrags, mit fuenf Minuten Spielraum fuer eine falsch gehende Uhr.
 */
const RESTARTED = `d.last_boot_at > coalesce(j.restarting_at, j.created_at + interval '5 minutes')`;

const JOB_COLUMNS = `
  j.id, j.request_id, r.reason, j.device_id, d.hostname, j.state, j.created_at, j.delivered_at,
  j.notified_at, j.deadline_at, j.deferrals, j.deferred_until, j.last_user, j.completed_at,
  j.error, j.events
`;

@Injectable()
export class RestartJobsService {
  private readonly logger = new Logger(RestartJobsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {}

  // --- Anlegen ------------------------------------------------------------------

  /**
   * Legt je Geraet einen Auftrag an — soweit es einen bekommen kann.
   *
   * Uebergangen werden Geraete, die nicht aktiv sind oder keinen Agent haben,
   * Server, Agents vor 0.9.0 und Geraete mit einem offenen Neustart. Die
   * Antwort zaehlt die Gruende, damit eine Mehrfachauswahl nicht
   * stillschweigend schrumpft.
   */
  async create(dto: CreateRestartJobsDto, createdBy: string): Promise<CreateRestartJobsResultDto> {
    const deviceIds = [...new Set(dto.deviceIds)];
    const devices: Array<{
      id: string;
      status: DeviceStatus;
      enrolled: boolean;
      agent_version: string | null;
      server: boolean;
      open_job: boolean;
    }> = await this.dataSource.query(
      `SELECT d.id, d.status, d.enrolled_at IS NOT NULL AS enrolled, d.agent_version,
              coalesce(d.os_name, '') ILIKE '%server%' AS server,
              EXISTS (SELECT 1 FROM restart_jobs j WHERE j.device_id = d.id AND j.state IN ${OPEN}) AS open_job
         FROM devices d
        WHERE d.id = ANY($1::uuid[])`,
      [deviceIds],
    );

    const skipped = { openJob: 0, agentTooOld: 0, server: 0, notEligible: deviceIds.length - devices.length };
    const eligible: string[] = [];

    for (const device of devices) {
      if (device.status !== DeviceStatus.Active || !device.enrolled) skipped.notEligible++;
      else if (device.server) skipped.server++;
      else if (!isVersionAtLeast(device.agent_version, MIN_RESTART_AGENT_VERSION)) skipped.agentTooOld++;
      else if (device.open_job) skipped.openJob++;
      else eligible.push(device.id);
    }

    const { expiryDays, ...rules } = await this.settings.getRestart();
    const reason = dto.reason?.trim() || null;

    let created = 0;
    const requestId = await this.dataSource.transaction(async (manager): Promise<string | null> => {
      if (eligible.length === 0) return null;

      const [request] = (await manager.query(
        `INSERT INTO restart_requests (reason, settings, requested_devices, created_by)
         VALUES ($1, $2::jsonb, $3, $4)
         RETURNING id`,
        [reason, JSON.stringify(rules), deviceIds.length, createdBy],
      )) as Array<{ id: string }>;

      // ON CONFLICT: Ein gleichzeitig angelegter zweiter Auftrag prallt am Index ab.
      const rows: unknown[] = await manager.query(
        `INSERT INTO restart_jobs (request_id, device_id, expires_at)
         SELECT $1, t.device_id, now() + make_interval(days => $2::int)
           FROM unnest($3::uuid[]) AS t(device_id)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [request.id, expiryDays, eligible],
      );
      created = rows.length;
      skipped.openJob += eligible.length - created;

      if (created === 0) {
        await manager.query('DELETE FROM restart_requests WHERE id = $1', [request.id]);
        return null;
      }

      await manager.query('UPDATE restart_requests SET skipped = $2::jsonb WHERE id = $1', [
        request.id,
        JSON.stringify(skipped),
      ]);
      return request.id;
    });

    this.logger.log(
      `${created} Neustart-Auftrag/-Auftraege von ${createdBy} angelegt, ${deviceIds.length - created} uebergangen.`,
    );

    return { requestId, created, skipped, minimumAgentVersion: MIN_RESTART_AGENT_VERSION };
  }

  // --- Anzeigen -----------------------------------------------------------------

  async listRequests(page: number, limit: number): Promise<RestartRequestListDto> {
    await this.cleanup();

    const states = Object.values(RestartJobState);
    const stateCounts = states
      .map((state) => `count(j.id) FILTER (WHERE j.state = '${state}')::int AS "state_${state}"`)
      .join(',\n              ');

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT r.id, r.reason, r.settings, r.requested_devices, r.skipped, r.created_by, r.created_at,
              count(j.id)::int AS devices,
              ${stateCounts},
              coalesce(sum(j.deferrals), 0)::int AS deferrals,
              max(j.completed_at) AS last_completed_at
         FROM restart_requests r
         LEFT JOIN restart_jobs j ON j.request_id = r.id
        GROUP BY r.id
        ORDER BY r.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );

    const totals: Array<{ total: number }> = await this.dataSource.query(
      'SELECT count(*)::int AS total FROM restart_requests',
    );

    return {
      items: rows.map((row) => ({
        id: row.id as string,
        reason: (row.reason as string | null) ?? null,
        rules: rulesOf(row.settings as StoredRules),
        requestedDevices: Number(row.requested_devices),
        skipped: (row.skipped as CreateRestartJobsResultDto['skipped'] | null) ?? null,
        createdBy: row.created_by as string,
        createdAt: iso(row.created_at) ?? '',
        devices: Number(row.devices),
        states: Object.fromEntries(states.map((state) => [state, Number(row[`state_${state}`])])) as Record<
          RestartJobState,
          number
        >,
        deferrals: Number(row.deferrals),
        lastCompletedAt: iso(row.last_completed_at),
      })),
      total: Number(totals[0]?.total ?? 0),
      page,
      limit,
    };
  }

  /** Die Auftraege einer Anfrage, ein Geraet je Zeile. */
  async requestJobs(requestId: string): Promise<RestartJobViewDto[]> {
    await this.requireRequest(requestId);
    await this.cleanup();
    return this.jobs('j.request_id = $1', [requestId], 'd.hostname ASC', 5000);
  }

  /** Die Auftraege eines Geraets, neueste zuerst. */
  async deviceJobs(deviceId: string, limit: number): Promise<RestartJobViewDto[]> {
    await this.cleanup(deviceId);
    return this.jobs('j.device_id = $1', [deviceId], 'j.created_at DESC', limit);
  }

  private async jobs(where: string, params: unknown[], order: string, limit: number): Promise<RestartJobViewDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${JOB_COLUMNS}
         FROM restart_jobs j
         JOIN restart_requests r ON r.id = j.request_id
         JOIN devices d ON d.id = j.device_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ${Number(limit)}`,
      params,
    );

    return rows.map((row) => ({
      id: row.id as string,
      requestId: row.request_id as string,
      reason: (row.reason as string | null) ?? null,
      deviceId: row.device_id as string,
      hostname: row.hostname as string,
      state: row.state as RestartJobState,
      createdAt: iso(row.created_at) ?? '',
      deliveredAt: iso(row.delivered_at),
      notifiedAt: iso(row.notified_at),
      deadlineAt: iso(row.deadline_at),
      deferrals: Number(row.deferrals),
      deferredUntil: iso(row.deferred_until),
      lastUser: (row.last_user as string | null) ?? null,
      completedAt: iso(row.completed_at),
      error: (row.error as string | null) ?? null,
      events: (row.events as RestartEventDto[] | null) ?? [],
    }));
  }

  // --- Abbrechen ----------------------------------------------------------------

  /**
   * Bricht ab, was von einer Anfrage noch nicht eingeleitet ist. Der Agent
   * erfaehrt es beim naechsten Check-in und schliesst eine offene Meldung.
   */
  async cancelRequest(requestId: string): Promise<number> {
    await this.requireRequest(requestId);
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE restart_jobs SET state = 'cancelled', completed_at = now(), deferred_until = NULL,
                events = events || jsonb_build_array(jsonb_build_object('at', now(), 'state', 'cancelled'))
          WHERE request_id = $1 AND state IN ${CANCELLABLE}
          RETURNING id`,
        [requestId],
      ),
    );
    if (rows.length > 0) {
      this.logger.log(`Neustart-Anfrage ${requestId}: ${rows.length} Auftrag/Auftraege abgebrochen.`);
    }
    return rows.length;
  }

  async cancelJob(id: string): Promise<void> {
    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE restart_jobs SET state = 'cancelled', completed_at = now(), deferred_until = NULL,
                events = events || jsonb_build_array(jsonb_build_object('at', now(), 'state', 'cancelled'))
          WHERE id = $1 AND state IN ${CANCELLABLE}
          RETURNING id`,
        [id],
      ),
    );
    if (rows.length > 0) return;

    const exists: unknown[] = await this.dataSource.query('SELECT 1 FROM restart_jobs WHERE id = $1', [id]);
    if (exists.length === 0) throw new NotFoundException('Auftrag nicht gefunden.');
    throw new ConflictException('Der Neustart ist bereits eingeleitet oder abgeschlossen.');
  }

  private async requireRequest(requestId: string): Promise<void> {
    const exists: unknown[] = await this.dataSource.query('SELECT 1 FROM restart_requests WHERE id = $1', [
      requestId,
    ]);
    if (exists.length === 0) throw new NotFoundException('Neustart-Anfrage nicht gefunden.');
  }

  // --- Agent --------------------------------------------------------------------

  /**
   * Der offene Auftrag eines Geraets fuer die Check-in-Antwort.
   *
   * Er geht mit jedem Check-in mit, bis der Neustart eingeleitet ist: Der
   * Agent erkennt daran auch, dass ein Auftrag weggefallen ist — abgebrochen,
   * verfallen oder durch einen Neustart des Benutzers erledigt — und schliesst
   * dann eine offene Meldung.
   */
  async claim(deviceId: string, agentVersion: string | null | undefined): Promise<RestartRequestDto | null> {
    if (!isVersionAtLeast(agentVersion, MIN_RESTART_AGENT_VERSION)) {
      return null;
    }

    await this.cleanup(deviceId);

    await this.dataSource.query(
      `UPDATE restart_jobs SET state = 'delivered', delivered_at = now(),
              events = events || jsonb_build_array(jsonb_build_object('at', now(), 'state', 'delivered'))
        WHERE device_id = $1 AND state = 'pending'`,
      [deviceId],
    );

    const rows: Array<{ id: string; reason: string | null; settings: StoredRules }> = await this.dataSource.query(
      `SELECT j.id, r.reason, r.settings
         FROM restart_jobs j
         JOIN restart_requests r ON r.id = j.request_id
        WHERE j.device_id = $1 AND j.state IN ('delivered', 'notified', 'deferred')
        ORDER BY j.created_at
        LIMIT 1`,
      [deviceId],
    );

    const job = rows[0];
    if (!job) return null;

    return {
      jobId: job.id,
      reason: job.reason,
      deferralMinutes: job.settings.deferralMinutes,
      nextMorningHour: job.settings.nextMorningHour,
      maxDeferrals: job.settings.maxDeferrals,
      deadlineHours: job.settings.deadlineHours,
      countdownMinutes: job.settings.countdownMinutes,
      promptText: promptTextFrom(job.settings),
      message: null,
    };
  }

  /** Rueckmeldung des Agents. Nur eigene, offene Auftraege — kein Geraet schliesst fremde. */
  async reportResult(deviceId: string, dto: RestartResultDto): Promise<void> {
    const at = dto.at ?? new Date().toISOString();

    const rows = returnedRows(
      await this.dataSource.query(
        `UPDATE restart_jobs SET
           state          = $3::restart_job_state,
           notified_at    = CASE WHEN $3 = 'notified' THEN coalesce(notified_at, $4::timestamptz) ELSE notified_at END,
           deadline_at    = coalesce($5::timestamptz, deadline_at),
           deferrals      = coalesce($6::int, deferrals),
           deferred_until = CASE WHEN $3 = 'deferred' THEN $7::timestamptz END,
           last_user      = coalesce($8, last_user),
           restarting_at  = CASE WHEN $3 = 'restarting' THEN $4::timestamptz ELSE restarting_at END,
           completed_at   = CASE WHEN $3 = 'failed' THEN now() ELSE completed_at END,
           error          = CASE WHEN $3 = 'failed' THEN $9 ELSE error END,
           events         = events || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                              'at', $4::timestamptz, 'state', $3::text, 'user', $8::text,
                              'until', $7::timestamptz, 'note', coalesce($10, $9)::text)))
         WHERE id = $1 AND device_id = $2 AND state IN ${OPEN}
         RETURNING id`,
        [
          dto.jobId,
          deviceId,
          dto.state,
          at,
          dto.deadlineAt ?? null,
          dto.deferrals ?? null,
          dto.deferredUntil ?? null,
          dto.user ?? null,
          dto.error ?? null,
          dto.note ?? null,
        ],
      ),
    );

    if (rows.length === 0) {
      throw new NotFoundException('Auftrag nicht gefunden oder nicht mehr offen.');
    }

    if (dto.state === 'failed') {
      this.logger.warn(`Neustart auf Geraet ${deviceId} gescheitert: ${dto.error ?? 'ohne Angabe'}`);
    }
  }

  // --- Aufraeumen ---------------------------------------------------------------

  /**
   * Schliesst, was erledigt ist oder nicht mehr kommt: Auftraege, nach denen
   * das Geraet neu gestartet hat, und solche, die bis zur Frist nicht
   * abgeholt wurden. Laeuft beim Ausliefern und beim Anzeigen — ein eigener
   * Zeitgeber braucht es dafuer nicht.
   */
  private async cleanup(deviceId?: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE restart_jobs j SET state = 'done', completed_at = now(), deferred_until = NULL,
              events = j.events || jsonb_build_array(jsonb_build_object('at', d.last_boot_at, 'state', 'done'))
         FROM devices d
        WHERE d.id = j.device_id
          AND j.state IN ${OPEN}
          AND ${RESTARTED}
          AND ($1::uuid IS NULL OR j.device_id = $1)`,
      [deviceId ?? null],
    );

    await this.dataSource.query(
      `UPDATE restart_jobs SET state = 'expired', completed_at = now(),
              events = events || jsonb_build_array(jsonb_build_object('at', now(), 'state', 'expired'))
        WHERE state IN ('pending', 'delivered') AND expires_at <= now()
          AND ($1::uuid IS NULL OR device_id = $1)`,
      [deviceId ?? null],
    );
  }
}

/** Die Regeln, wie sie mit einer Anfrage gespeichert wurden — vor 0.9.1 mit Zusatztext statt Text. */
type StoredRules = Omit<RestartSettings, 'expiryDays' | 'promptText'> & { promptText?: string; message?: string };

function rulesOf(stored: StoredRules): RestartRulesDto {
  const { message: _legacy, ...rules } = stored;
  return { ...rules, promptText: promptTextFrom(stored) };
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
