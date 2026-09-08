import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  ARCHIVE_REASON_GONE,
  ARCHIVE_REASON_OUT_OF_SCOPE,
} from '../database/archive-reasons.js';
import { AdSyncStatus, AdSyncTrigger, DeviceStatus } from '../database/enums.js';
import { SettingsService } from '../settings/settings.service.js';
import { effectiveSearchBases, isAdConfigured } from '../settings/settings.types.js';
import { AdComputer, LdapClient } from './ldap.client.js';

export interface AdSyncResult {
  id: string;
  status: AdSyncStatus;
  devicesFound: number;
  devicesCreated: number;
  devicesArchived: number;
  devicesReactivated: number;
  error: string | null;
}

/**
 * Zwei Gruende, weil dahinter zwei verschiedene Sachverhalte stehen.
 *
 * Ein Konto, das im Verzeichnis geloescht wurde, ist ausgemustert. Ein Konto,
 * das nur nicht mehr in den abgeglichenen Bereichen liegt, existiert weiterhin
 * — es wurde verschoben oder eine Organisationseinheit wurde aus den
 * Einstellungen genommen. Wer die Geraeteliste liest, soll das auseinander
 * halten koennen, ohne im AD nachzusehen.
 *
 * Die Texte liegen in <c>archive-reasons.ts</c>, weil die Registrierung sie
 * ebenfalls auswerten muss.
 */

@Injectable()
export class AdSyncService {
  private readonly logger = new Logger(AdSyncService.name);

  /**
   * Ein Abgleich zur Zeit. Ein manueller Trigger waehrend eines laufenden
   * Intervalls wuerde sonst dieselben Konten doppelt verarbeiten — und im
   * ungluecklichen Fall archivieren, was der andere Lauf gerade erst angelegt hat.
   */
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ldap: LdapClient,
    private readonly settings: SettingsService,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async sync(trigger: AdSyncTrigger): Promise<AdSyncResult> {
    const config = await this.settings.getAd();

    if (!isAdConfigured(config)) {
      throw new ConflictException(
        'Die AD-Anbindung ist nicht konfiguriert. Server und Suchwurzel fehlen (Einstellungen).',
      );
    }

    if (this.running) {
      throw new ConflictException('Es laeuft bereits ein Abgleich.');
    }

    this.running = true;
    const runId = await this.startRun(trigger);

    try {
      const computers = await this.ldap.fetchComputers(config);

      // Kein einziger Treffer ist kein leeres Verzeichnis, sondern fast immer
      // eine falsche Suchwurzel oder ein zu enger Filter. Wuerde der Abgleich
      // hier normal weiterlaufen, gaelte jedes AD-Geraet als verschwunden und
      // die gesamte Flotte waere nach einem Tippfehler archiviert.
      if (computers.length === 0) {
        throw new Error(
          'Die LDAP-Suche lieferte kein einziges Computerkonto. Der Abgleich wurde abgebrochen, ' +
            'damit nicht faelschlich alle Geraete archiviert werden. Bitte AD_BASE_DN und AD_FILTER pruefen.',
        );
      }

      const result = await this.apply(computers, effectiveSearchBases(config));

      await this.finishRun(runId, AdSyncStatus.Success, result, null);

      this.logger.log(
        `AD-Abgleich abgeschlossen: ${result.devicesFound} gefunden, ` +
          `${result.devicesCreated} neu, ${result.devicesReactivated} reaktiviert, ` +
          `${result.devicesArchived} archiviert.`,
      );

      return { id: runId, status: AdSyncStatus.Success, error: null, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishRun(
        runId,
        AdSyncStatus.Failed,
        { devicesFound: 0, devicesCreated: 0, devicesArchived: 0 },
        message,
      );

      this.logger.error(`AD-Abgleich fehlgeschlagen: ${message}`);

      return {
        id: runId,
        status: AdSyncStatus.Failed,
        devicesFound: 0,
        devicesCreated: 0,
        devicesArchived: 0,
        devicesReactivated: 0,
        error: message,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Der gesamte Abgleich laeuft in einer Transaktion.
   *
   * Der Grund ist der Archivierungsschritt: Er leitet aus der Abwesenheit in
   * der gelesenen Liste ab, dass ein Geraet verschwunden ist. Braeche der Lauf
   * nach dem Einlesen und vor dem Archivieren ab, bliebe ein halber Stand
   * zurueck — und beim naechsten Lauf saehe alles richtig aus.
   */
  private async apply(
    computers: AdComputer[],
    searchBases: string[],
  ): Promise<Omit<AdSyncResult, 'id' | 'status' | 'error'>> {
    return this.dataSource.transaction(async (manager) => {
      let created = 0;
      let reactivated = 0;

      for (const computer of computers) {
        const outcome = await this.upsert(manager, computer);
        if (outcome === 'created') created++;
        if (outcome === 'reactivated') reactivated++;
      }

      const archived = await this.archiveMissing(manager, computers, searchBases);

      return {
        devicesFound: computers.length,
        devicesCreated: created,
        devicesReactivated: reactivated,
        devicesArchived: archived,
      };
    });
  }

  private async upsert(
    manager: EntityManager,
    computer: AdComputer,
  ): Promise<'created' | 'updated' | 'reactivated'> {
    // Zuerst ueber die GUID: sie ueberlebt Umbenennungen und Verschiebungen.
    const byGuid: Array<{ id: string; status: DeviceStatus }> = await manager.query(
      'SELECT id, status FROM devices WHERE ad_object_guid = $1',
      [computer.objectGuid],
    );

    let existing = byGuid[0];

    if (!existing) {
      // Kein Treffer ueber die GUID: Moeglicherweise hat sich der Agent schon
      // gemeldet, bevor der erste Abgleich lief. Dann gibt es das Geraet
      // bereits — nur ohne AD-Bezug, den wir hier nachtragen.
      const byHostname: Array<{ id: string; status: DeviceStatus }> = await manager.query(
        `SELECT id, status FROM devices
          WHERE ad_object_guid IS NULL AND lower(hostname) = lower($1)
          ORDER BY enrolled_at DESC NULLS LAST
          LIMIT 1`,
        [computer.hostname],
      );
      existing = byHostname[0];
    }

    if (!existing) {
      await manager.query(
        `INSERT INTO devices (hostname, ad_dn, ad_object_guid, ad_ou, os_name, os_version, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [
          computer.hostname,
          computer.distinguishedName,
          computer.objectGuid,
          computer.organizationalUnit,
          computer.operatingSystem,
          computer.operatingSystemVersion,
        ],
      );
      return 'created';
    }

    const wasArchived = existing.status === DeviceStatus.Archived;

    await manager.query(
      `UPDATE devices SET
         hostname       = $2,
         ad_dn          = $3,
         ad_object_guid = $4,
         ad_ou          = $5,
         -- Die Angaben aus dem AD sind grob und oft veraltet. Sie fuellen nur
         -- Luecken; was der Agent gemeldet hat, bleibt unangetastet.
         os_name        = CASE WHEN enrolled_at IS NULL THEN $6 ELSE coalesce(os_name, $6) END,
         os_version     = CASE WHEN enrolled_at IS NULL THEN $7 ELSE coalesce(os_version, $7) END,
         -- Ein Geraet, das wieder im AD auftaucht, ist offensichtlich wieder da.
         status          = 'active',
         archived_at     = NULL,
         archived_reason = NULL,
         updated_at      = now()
       WHERE id = $1`,
      [
        existing.id,
        computer.hostname,
        computer.distinguishedName,
        computer.objectGuid,
        computer.organizationalUnit,
        computer.operatingSystem,
        computer.operatingSystemVersion,
      ],
    );

    return wasArchived ? 'reactivated' : 'updated';
  }

  /**
   * Archiviert, was im AD nicht mehr auftaucht — und zwar ausschliesslich
   * Geraete, die dort einmal waren.
   *
   * Ein per Agent registriertes Geraet ohne GUID darf hier nicht hineinfallen:
   * Es steht vielleicht ausserhalb der konfigurierten Suchwurzel oder gehoert
   * gar nicht zur Domaene. Es zu archivieren, weil eine LDAP-Abfrage es nicht
   * gefunden hat, waere schlicht falsch.
   *
   * Geloescht wird nie. Die Historie eines ausgemusterten Geraets bleibt
   * auswertbar.
   *
   * Hierher faellt auch, wessen Organisationseinheit aus den Einstellungen
   * genommen wurde: Das Konto steht dann nicht mehr in der gelesenen Liste. Der
   * Vergleich des gespeicherten DN mit den abgeglichenen Bereichen unterscheidet
   * diesen Fall vom geloeschten Konto — er dient nur dem Grund, nicht der
   * Auswahl.
   */
  private async archiveMissing(
    manager: EntityManager,
    computers: AdComputer[],
    searchBases: string[],
  ): Promise<number> {
    const guids = computers.map((c) => c.objectGuid);

    const result: Array<{ id: string }> = await manager.query(
      `UPDATE devices d SET
         status          = 'archived',
         archived_at     = now(),
         archived_reason = CASE
           WHEN d.ad_dn IS NOT NULL
            AND coalesce(array_length($4::text[], 1), 0) > 0
            AND NOT EXISTS (
              SELECT 1 FROM unnest($4::text[]) AS base
               -- Suffixvergleich statt LIKE: In einem DN koennen '%' und '_'
               -- vorkommen, und ein Muster muesste sie erst maskieren.
               WHERE lower(d.ad_dn) = lower(base)
                  OR lower(right(d.ad_dn, length(base) + 1)) = lower(',' || base)
            )
           THEN $3
           ELSE $2
         END,
         updated_at      = now()
       WHERE ad_object_guid IS NOT NULL
         AND status = 'active'
         AND NOT (ad_object_guid = ANY($1::uuid[]))
       RETURNING id`,
      [guids, ARCHIVE_REASON_GONE, ARCHIVE_REASON_OUT_OF_SCOPE, searchBases],
    );

    return result.length;
  }

  private async startRun(trigger: AdSyncTrigger): Promise<string> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO ad_sync_runs (trigger, status) VALUES ($1, 'running') RETURNING id`,
      [trigger],
    );
    return rows[0].id;
  }

  private async finishRun(
    id: string,
    status: AdSyncStatus,
    counts: Pick<AdSyncResult, 'devicesFound' | 'devicesCreated' | 'devicesArchived'>,
    error: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ad_sync_runs SET
         finished_at      = now(),
         status           = $2,
         devices_found    = $3,
         devices_created  = $4,
         devices_archived = $5,
         error            = $6
       WHERE id = $1`,
      [id, status, counts.devicesFound, counts.devicesCreated, counts.devicesArchived, error],
    );
  }

  async recentRuns(limit: number, offset = 0): Promise<Array<Record<string, unknown>>> {
    return this.dataSource.query(
      `SELECT id, started_at, finished_at, trigger, devices_found, devices_created,
              devices_archived, status, error
         FROM ad_sync_runs
        ORDER BY started_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  async countRuns(): Promise<number> {
    const rows: Array<{ total: string }> = await this.dataSource.query(
      'SELECT count(*)::text AS total FROM ad_sync_runs',
    );
    return Number(rows[0]?.total ?? 0);
  }
}
