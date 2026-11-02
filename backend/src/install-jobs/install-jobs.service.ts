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
    const spreadMs = eligible.length > 1 ? (dto.spreadMinutes ?? DEFAULT_SPREAD_MINUTES) * 60_000 : 0;

    let created = 0;
    for (const deviceId of eligible) {
      const notBefore = new Date(start + Math.floor(Math.random() * spreadMs));
      const expiresAt = new Date(notBefore.getTime() + expiryDays * 86_400_000);

      // ON CONFLICT: Ein gleichzeitiger zweiter Auftrag prallt am Index ab,
      // statt als Fehler zu enden.
      const rows: unknown[] = await this.dataSource.query(
        `INSERT INTO update_install_jobs
           (device_id, scope, update_ids, classifications, not_before, expires_at, created_by)
         VALUES ($1, $2, $3::uuid[], $4::text[], $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [deviceId, dto.scope, updateIds, classifications, notBefore, expiresAt, createdBy],
      );
      if (rows.length > 0) created++;
      else skipped.openJob++;
    }

    this.logger.log(
      `${created} Installationsauftrag/-auftraege (${dto.scope}) von ${createdBy} angelegt, ` +
        `${deviceIds.length - created} uebergangen.`,
    );

    return { created, skipped, expiryDays, minimumAgentVersion: MIN_INSTALL_AGENT_VERSION };
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

  async list(limit: number, deviceId?: string): Promise<InstallJobViewDto[]> {
    await this.cleanup(deviceId);

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT j.id, j.device_id, d.hostname, j.scope, cardinality(j.update_ids) AS selected_count,
              j.classifications, j.state, j.not_before, j.expires_at, j.created_by, j.created_at,
              j.delivered_at, j.started_at, j.completed_at, j.result, j.error
         FROM update_install_jobs j
         JOIN devices d ON d.id = j.device_id
        WHERE $2::uuid IS NULL OR j.device_id = $2
        ORDER BY j.created_at DESC
        LIMIT $1`,
      [limit, deviceId ?? null],
    );

    const titles = await this.catalogTitles(rows);

    return rows.map((row) => ({
      id: row.id as string,
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
