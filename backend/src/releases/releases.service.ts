import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DataSource } from 'typeorm';
import { AgentUpdateJobState } from '../database/enums.js';
import {
  AgentReleaseDto,
  AgentUpdateJobDto,
  AgentUpdateJobViewDto,
  CreateUpdateJobsResultDto,
  UpdateResultDto,
  VERSION_PATTERN,
} from './dto/release.dto.js';
import { PeVersionError, readProductVersion } from './pe-version.js';

const BINARY_NAME = 'wiupmo-agent.exe';

@Injectable()
export class ReleasesService implements OnModuleInit {
  private readonly logger = new Logger(ReleasesService.name);
  private readonly root: string;
  private readonly bundled: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.root = resolve(config.get<string>('AGENT_RELEASES_DIR') ?? '/app/agent-releases');

    // Leer setzen schaltet die Aufnahme ab — fuer den Fall, dass jemand
    // ausschliesslich selbst gebaute Binaries verteilen will.
    this.bundled = (config.get<string>('AGENT_BUNDLED_BINARY') ?? '/app/agent/wiupmo-agent.exe').trim();
  }

  /**
   * Prueft die Ablage beim Start und nimmt das mitgelieferte Binary auf.
   *
   * Ohne die Pruefung faellt ein unbeschreibbares Verzeichnis erst beim
   * Hochladen auf — nach 75 uebertragenen Megabyte. Es ist kein Grund, den
   * Start abzubrechen: Alles andere am Backend funktioniert weiterhin.
   */
  async onModuleInit(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.W_OK);
    } catch (error) {
      this.logger.error(
        `Die Ablage fuer Agent-Binaries (${this.root}) ist nicht beschreibbar: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Das Hochladen einer Agent-Version wird scheitern, solange das so bleibt.',
      );
      return;
    }

    await this.adoptBundled();
  }

  /**
   * Nimmt das im Image mitgelieferte Agent-Binary auf, sofern seine Version
   * noch nicht hinterlegt ist.
   *
   * Damit entfaellt der Upload von Hand: Wer das Backend aktualisiert, hat den
   * passenden Agent bereits im Haus. Ausgerollt wird trotzdem nicht von selbst
   * — welche Version auf die Flotte geht, bleibt eine bewusste Entscheidung.
   * Die eine Ausnahme ist die Erstinstallation: Solange gar keine Version als
   * aktuell markiert ist, waere das Zoegern sinnlos.
   *
   * Fehler bleiben hier folgenlos. Ein Backend, das wegen eines fehlenden
   * Binaries nicht startet, waere die schlechtere Eigenschaft.
   */
  private async adoptBundled(): Promise<void> {
    if (this.bundled === '') {
      return;
    }

    try {
      await access(this.bundled, constants.R_OK);
    } catch {
      // Kein mitgeliefertes Binary — bei einem Image ohne Agent-Stufe und in
      // der Entwicklung der Normalfall. Trotzdem eine Zeile wert: Ohne sie ist
      // der haeufigste Fall ("warum erscheint keine Version?") der einzige, der
      // gar nichts hinterlaesst.
      this.logger.log(`Kein mitgeliefertes Agent-Binary unter ${this.bundled}.`);
      return;
    }

    try {
      const version = (await readProductVersion(this.bundled)).split('+')[0].trim();

      if (!VERSION_PATTERN.test(version)) {
        this.logger.warn(`Mitgeliefertes Agent-Binary meldet die Version "${version}" — uebergangen.`);
        return;
      }

      const existing: Array<{ id: string }> = await this.dataSource.query(
        'SELECT id FROM agent_releases WHERE version = $1',
        [version],
      );

      if (existing.length > 0) {
        return;
      }

      const target = this.binaryPath(version);
      await mkdir(join(this.root, version), { recursive: true });
      // Kopieren, nicht verschieben: Die Quelle gehoert dem Image und muss
      // einen Neustart des Containers ueberstehen.
      await copyFile(this.bundled, target);

      const sha256 = await this.hashFile(target);
      const { size } = await stat(target);

      await this.dataSource.query(
        `INSERT INTO agent_releases (version, file_path, sha256, size_bytes, notes, is_current)
         VALUES ($1, $2, $3, $4, $5, NOT EXISTS (SELECT 1 FROM agent_releases WHERE is_current))
         ON CONFLICT (version) DO NOTHING`,
        [version, target, sha256, String(size), 'Mit dem Backend-Image ausgeliefert.'],
      );

      this.logger.log(`Mitgelieferte Agent-Version ${version} aufgenommen.`);
    } catch (error) {
      this.logger.warn(
        'Das mitgelieferte Agent-Binary konnte nicht aufgenommen werden: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    provided: string | undefined,
    notes: string | undefined,
    temporaryPath: string,
  ): Promise<AgentReleaseDto> {
    try {
      const version = await this.detectVersion(temporaryPath, provided);

      const existing: Array<{ id: string }> = await this.dataSource.query(
        'SELECT id FROM agent_releases WHERE version = $1',
        [version],
      );

      if (existing.length > 0) {
        throw new ConflictException(
          `Version ${version} ist bereits hinterlegt. Eine bestehende Version wird nicht ` +
            'ueberschrieben — im Feld koennten Geraete darauf verweisen.',
        );
      }

      const sha256 = await this.hashFile(temporaryPath);
      const { size } = await stat(temporaryPath);

      const target = this.binaryPath(version);
      await this.store(temporaryPath, version, target);

      const rows: Array<{ id: string }> = await this.dataSource.query(
        `INSERT INTO agent_releases (version, file_path, sha256, size_bytes, notes, is_current)
         VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [version, target, sha256, String(size), notes ?? null],
      );

      this.logger.log(`Agent-Release ${version} aufgenommen (${size} Bytes, sha256 ${sha256}).`);

      const all = await this.list();
      return all.find((release) => release.id === rows[0].id)!;
    } finally {
      // Auf jedem Weg hinaus. Nach einem erfolgreichen Verschieben ist der Pfad
      // ohnehin leer, und ein abgebrochener Upload soll keine 75 MB im
      // temporaeren Verzeichnis liegen lassen.
      await rm(temporaryPath, { force: true });
    }
  }

  /**
   * Legt die hochgeladene Datei an ihren Platz.
   *
   * Verschieben zuerst, Kopieren als Rueckfall: Die Datei liegt im temporaeren
   * Verzeichnis des Containers, das Ziel in einem eingehaengten Volume. Das
   * sind zwei Dateisysteme, und ueber deren Grenze hinweg kann `rename` nicht
   * arbeiten — es meldet `EXDEV`.
   */
  private async store(temporaryPath: string, version: string, target: string): Promise<void> {
    try {
      await mkdir(join(this.root, version), { recursive: true });

      try {
        await rename(temporaryPath, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
          throw error;
        }

        // Die Quelle raeumt der aufrufende `finally`-Zweig weg.
        await copyFile(temporaryPath, target);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        this.logger.error(`Ablage nicht beschreibbar (${code}): ${this.root}`);

        throw new InternalServerErrorException(
          `Die Ablage fuer Agent-Binaries (${this.root}) ist fuer das Backend nicht ` +
            `beschreibbar (${code}). Vermutlich gehoert das eingehaengte Volume root, ` +
            'waehrend der Container unter einem anderen Benutzer laeuft.',
        );
      }

      throw error;
    }
  }

  /**
   * Die Version kommt aus der Programmdatei, nicht aus einem Eingabefeld.
   *
   * Getippt war sie eine Fehlerquelle mit unangenehmer Wirkung: Weicht sie von
   * dem ab, was der Agent von sich meldet, gilt das Geraet nach dem Update
   * weiterhin als abweichend — und bekommt beim naechsten Check-in denselben
   * Auftrag erneut, endlos.
   */
  private async detectVersion(path: string, provided?: string): Promise<string> {
    let fromFile: string;

    try {
      // Das SDK haengt an die InformationalVersion ein "+<commit>" an. Der Agent
      // schneidet es beim Melden ab (AgentVersion.cs); hier muss dasselbe
      // geschehen, sonst stimmen die beiden Werte nie ueberein.
      fromFile = (await readProductVersion(path)).split('+')[0].trim();
    } catch (error) {
      if (!(error instanceof PeVersionError)) {
        throw error;
      }

      // Ohne Versionsangabe in der Datei bleibt der von Hand gesetzte Wert.
      if (provided) {
        return provided;
      }

      throw new BadRequestException(
        `Aus der Datei liess sich keine Version lesen (${error.message}) ` +
          'Bitte die Version angeben oder eine Datei mit Versionsangabe hochladen.',
      );
    }

    if (!VERSION_PATTERN.test(fromFile)) {
      throw new BadRequestException(
        `Die Datei meldet die Version "${fromFile}"; erwartet wird die Form 1.2.3.`,
      );
    }

    if (provided && provided !== fromFile) {
      throw new BadRequestException(
        `Die Datei meldet Version ${fromFile}, angegeben war ${provided}. ` +
          'Massgeblich ist, was der Agent von sich meldet.',
      );
    }

    return fromFile;
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

  /**
   * Dasselbe ueber die Kennung statt ueber die Version — fuer den Download aus
   * der Oberflaeche, wo die Zeile der Tabelle die Kennung ohnehin schon traegt.
   */
  async openBinaryById(id: string): Promise<{ version: string; path: string; sizeBytes: number }> {
    const rows: Array<{ version: string }> = await this.dataSource.query(
      'SELECT version FROM agent_releases WHERE id = $1',
      [id],
    );

    const version = rows[0]?.version;
    if (!version) {
      throw new NotFoundException('Release nicht gefunden.');
    }

    return { version, ...(await this.openBinary(version)) };
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
