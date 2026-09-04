import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DataSource } from 'typeorm';
import { AgentUpdateJobState } from '../database/enums.js';
import {
  AgentReleaseDto,
  AgentUpdateJobDto,
  AgentUpdateJobViewDto,
  CreateUpdateJobsResultDto,
  UpdateResultDto,
} from './dto/release.dto.js';

const BINARY_NAME = 'wiupmo-agent.exe';

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);
  private readonly root: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.root = resolve(config.get<string>('AGENT_RELEASES_DIR') ?? '/app/agent-releases');
  }

  /**
   * Der Pfad wird aus der bereits validierten Version zusammengesetzt und
   * anschliessend geprueft, dass er unterhalb des Wurzelverzeichnisses liegt.
   *
   * Die Musterpruefung im DTO allein waere zu wenig: Ein Pfad, der aus einem
   * Anfragewert entsteht, gehoert vor der Benutzung eingegrenzt — sonst ist es
   * eine Frage der Zeit, bis eine andere Aufrufstelle die Pruefung vergisst.
   */
  private binaryPath(version: string): string {
    const path = resolve(join(this.root, version, BINARY_NAME));

    if (!path.startsWith(this.root + sep)) {
      throw new BadRequestException('Ungueltige Version.');
    }

    return path;
  }

  // --- Releases ------------------------------------------------------------

  async list(): Promise<AgentReleaseDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT r.id, r.version, r.sha256, r.size_bytes, r.released_at, r.is_current, r.notes,
              (SELECT count(*) FROM devices d
                WHERE d.agent_version = r.version AND d.status = 'active') AS devices
         FROM agent_releases r
        ORDER BY r.released_at DESC`,
    );

    return rows.map((row) => ({
      id: row.id as string,
      version: row.version as string,
      sha256: row.sha256 as string,
      sizeBytes: String(row.size_bytes ?? '0'),
      releasedAt: iso(row.released_at) ?? '',
      isCurrent: row.is_current as boolean,
      notes: (row.notes as string | null) ?? null,
      devices: Number(row.devices ?? 0),
    }));
  }

  /**
   * Nimmt eine hochgeladene Datei auf. Sie liegt bereits auf der Platte —
   * multer schreibt sie dorthin, statt 75 MB im Speicher zu halten.
   */
  async publish(
    version: string,
    notes: string | undefined,
    temporaryPath: string,
  ): Promise<AgentReleaseDto> {
    const existing: Array<{ id: string }> = await this.dataSource.query(
      'SELECT id FROM agent_releases WHERE version = $1',
      [version],
    );

    if (existing.length > 0) {
      await rm(temporaryPath, { force: true });
      throw new ConflictException(
        `Version ${version} existiert bereits. Eine bestehende Version wird nicht ueberschrieben — ` +
          'im Feld koennten Geraete darauf verweisen.',
      );
    }

    const sha256 = await this.hashFile(temporaryPath);
    const { size } = await stat(temporaryPath);

    const target = this.binaryPath(version);
    await mkdir(join(this.root, version), { recursive: true });
    await rename(temporaryPath, target);

    const rows: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO agent_releases (version, file_path, sha256, size_bytes, notes, is_current)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
      [version, target, sha256, String(size), notes ?? null],
    );

    this.logger.log(`Agent-Release ${version} aufgenommen (${size} Bytes, sha256 ${sha256}).`);

    const all = await this.list();
    return all.find((release) => release.id === rows[0].id)!;
  }

  /**
   * Markiert eine Version als aktuell. Genau eine kann es sein — das
   * Zurücksetzen der anderen laeuft deshalb in derselben Transaktion.
   */
  async setCurrent(id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const rows: Array<{ version: string }> = await manager.query(
        'SELECT version FROM agent_releases WHERE id = $1',
        [id],
      );
      if (rows.length === 0) {
        throw new NotFoundException('Release nicht gefunden.');
      }

      await manager.query('UPDATE agent_releases SET is_current = false WHERE is_current');
      await manager.query('UPDATE agent_releases SET is_current = true WHERE id = $1', [id]);
    });
  }

  async remove(id: string): Promise<void> {
    const rows: Array<{ version: string; is_current: boolean }> = await this.dataSource.query(
      'SELECT version, is_current FROM agent_releases WHERE id = $1',
      [id],
    );

    const release = rows[0];
    if (!release) {
      throw new NotFoundException('Release nicht gefunden.');
    }
    if (release.is_current) {
      throw new ConflictException(
        'Die aktuelle Version laesst sich nicht entfernen. Zuerst eine andere als aktuell markieren.',
      );
    }

    const open: Array<{ count: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM agent_update_jobs
        WHERE target_version = $1 AND state IN ('pending', 'delivered', 'installing')`,
      [release.version],
    );

    if (Number(open[0]?.count ?? 0) > 0) {
      throw new ConflictException(
        'Auf diese Version verweisen noch offene Update-Auftraege. Sie wuerden ins Leere laufen.',
      );
    }

    await this.dataSource.query('DELETE FROM agent_releases WHERE id = $1', [id]);
    await rm(join(this.root, release.version), { recursive: true, force: true });
  }

  /** Fuer die Auslieferung an den Agent. */
  async openBinary(version: string): Promise<{ path: string; sizeBytes: number }> {
    const rows: Array<{ version: string }> = await this.dataSource.query(
      'SELECT version FROM agent_releases WHERE version = $1',
      [version],
    );
    if (rows.length === 0) {
      throw new NotFoundException('Version nicht gefunden.');
    }

    const path = this.binaryPath(version);

    try {
      const { size } = await stat(path);
      return { path, sizeBytes: size };
    } catch {
      // Datenbankeintrag ohne Datei: passiert, wenn das Volume neu angelegt
      // wurde. Als 404 statt als Serverfehler — der Agent soll es beim
      // naechsten Mal einfach wieder versuchen.
      throw new NotFoundException(`Die Datei zu Version ${version} fehlt auf dem Datentraeger.`);
    }
  }

  // --- Auftraege -----------------------------------------------------------

  /**
   * Legt Auftraege an. Ohne Geraeteliste alle aktiven Geraete mit
   * abweichender Version — das ist der Regelfall beim Ausrollen.
   */
  async createJobs(deviceIds: string[] | undefined, targetVersion?: string): Promise<CreateUpdateJobsResultDto> {
    const version = targetVersion ?? (await this.currentVersion());

    if (!version) {
      throw new ConflictException(
        'Es ist keine Version als aktuell markiert und keine angegeben.',
      );
    }

    const releases: Array<{ version: string }> = await this.dataSource.query(
      'SELECT version FROM agent_releases WHERE version = $1',
      [version],
    );
    if (releases.length === 0) {
      throw new NotFoundException(`Version ${version} ist nicht hinterlegt.`);
    }

    const rows: Array<{ id: string }> = await this.dataSource.query(
      `WITH kandidaten AS (
         SELECT d.id
           FROM devices d
          WHERE d.status = 'active'
            AND d.enrolled_at IS NOT NULL
            AND coalesce(d.agent_version, '') <> $1
            AND ($2::uuid[] IS NULL OR d.id = ANY($2::uuid[]))
            -- Kein zweiter Auftrag, solange einer offen ist: Zwei parallele
            -- Auftraege wuerden dasselbe Geraet zweimal tauschen lassen.
            AND NOT EXISTS (
              SELECT 1 FROM agent_update_jobs j
               WHERE j.device_id = d.id
                 AND j.state IN ('pending', 'delivered', 'installing')
            )
       )
       INSERT INTO agent_update_jobs (device_id, target_version, state)
       SELECT id, $1, 'pending' FROM kandidaten
       RETURNING id`,
      [version, deviceIds && deviceIds.length > 0 ? deviceIds : null],
    );

    // Wie viele waeren betroffen gewesen, sind aber wegen eines offenen
    // Auftrags uebergangen worden?
    const skipped: Array<{ count: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS count
         FROM devices d
        WHERE d.status = 'active'
          AND d.enrolled_at IS NOT NULL
          AND coalesce(d.agent_version, '') <> $1
          AND ($2::uuid[] IS NULL OR d.id = ANY($2::uuid[]))
          AND EXISTS (
            SELECT 1 FROM agent_update_jobs j
             WHERE j.device_id = d.id AND j.state IN ('pending', 'delivered', 'installing')
          )`,
      [version, deviceIds && deviceIds.length > 0 ? deviceIds : null],
    );

    this.logger.log(`${rows.length} Update-Auftraege auf Version ${version} angelegt.`);

    return { created: rows.length, skipped: Number(skipped[0]?.count ?? 0), targetVersion: version };
  }

  private async currentVersion(): Promise<string | null> {
    const rows: Array<{ version: string }> = await this.dataSource.query(
      'SELECT version FROM agent_releases WHERE is_current LIMIT 1',
    );
    return rows[0]?.version ?? null;
  }

  /**
   * Holt den offenen Auftrag eines Geraets und vermerkt ihn als ausgeliefert.
   *
   * Wird bei jedem Check-in aufgerufen. Ein bereits ausgelieferter Auftrag
   * wird erneut mitgegeben, solange er nicht abgeschlossen ist — sonst
   * bliebe ein Geraet haengen, das die Antwort beim ersten Mal nicht
   * verarbeiten konnte.
   */
  async claimJob(deviceId: string): Promise<AgentUpdateJobDto | null> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `UPDATE agent_update_jobs j SET
         state = CASE WHEN j.state = 'pending' THEN 'delivered' ELSE j.state END
       WHERE j.id = (
         SELECT id FROM agent_update_jobs
          WHERE device_id = $1 AND state IN ('pending', 'delivered')
          ORDER BY created_at ASC
          LIMIT 1
       )
       RETURNING j.id, j.target_version`,
      [deviceId],
    );

    const job = rows[0];
    if (!job) {
      return null;
    }

    const release: Array<{ sha256: string }> = await this.dataSource.query(
      'SELECT sha256 FROM agent_releases WHERE version = $1',
      [job.target_version],
    );

    if (!release[0]) {
      // Die Zielversion wurde entfernt. Auftrag als gescheitert schliessen,
      // statt den Agent auf eine nicht vorhandene Datei zu schicken.
      await this.reportResult(deviceId, {
        jobId: job.id as string,
        state: 'failed',
        error: 'Die Zielversion ist im Backend nicht mehr hinterlegt.',
      });
      return null;
    }

    return {
      jobId: job.id as string,
      targetVersion: job.target_version as string,
      sha256: release[0].sha256,
      downloadPath: `/api/agent/v1/binary/${job.target_version as string}`,
    };
  }

  /** Rueckmeldung des Agents. Nur eigene Auftraege, damit kein Geraet fremde schliesst. */
  async reportResult(deviceId: string, dto: UpdateResultDto): Promise<void> {
    const terminal = dto.state === 'done' || dto.state === 'failed';

    const rows: Array<{ id: string }> = await this.dataSource.query(
      `UPDATE agent_update_jobs SET
         state        = $3,
         completed_at = CASE WHEN $4 THEN now() ELSE completed_at END,
         error        = $5
       WHERE id = $1 AND device_id = $2
       RETURNING id`,
      [dto.jobId, deviceId, dto.state, terminal, dto.error ?? null],
    );

    if (rows.length === 0) {
      throw new NotFoundException('Auftrag nicht gefunden.');
    }

    if (dto.state === 'done' && dto.agentVersion) {
      await this.dataSource.query(
        'UPDATE devices SET agent_version = $2, updated_at = now() WHERE id = $1',
        [deviceId, dto.agentVersion],
      );
    }

    if (dto.state === 'failed') {
      this.logger.warn(`Selbst-Update auf Geraet ${deviceId} gescheitert: ${dto.error ?? 'ohne Angabe'}`);
    }
  }

  async jobs(limit: number): Promise<AgentUpdateJobViewDto[]> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT j.id, j.device_id, d.hostname, j.target_version, j.state,
              j.created_at, j.completed_at, j.error
         FROM agent_update_jobs j
         JOIN devices d ON d.id = j.device_id
        ORDER BY j.created_at DESC
        LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: row.id as string,
      deviceId: row.device_id as string,
      hostname: row.hostname as string,
      targetVersion: row.target_version as string,
      state: row.state as AgentUpdateJobState,
      createdAt: iso(row.created_at) ?? '',
      completedAt: iso(row.completed_at),
      error: (row.error as string | null) ?? null,
    }));
  }

  private hashFile(path: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolvePromise(hash.digest('hex')));
    });
  }
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
