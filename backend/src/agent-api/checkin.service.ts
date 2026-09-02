import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Device } from '../database/entities/index.js';
import { UpdateEventType, UpdateState } from '../database/enums.js';
import { SnapshotOutcome, SnapshotResultDto } from './dto/checkin.dto.js';
import {
  AvailableUpdateDto,
  HistoryEntryDto,
  HistoryOperation,
  OperationResultCode,
  SnapshotDto,
} from './dto/snapshot.dto.js';
import { buildValuesClause } from './sql-values.js';

/** Metadaten eines Updates, zusammengefuehrt aus Verfuegbar-Liste und Historie. */
interface CatalogEntry {
  updateId: string;
  revisionNumber: number | null;
  kbArticle: string | null;
  title: string;
  severity: string | null;
  categories: string[];
  isSecurity: boolean;
  msrcNumber: string | null;
  sizeBytes: string | null;
  supportUrl: string | null;
}

interface ExistingState {
  updateId: string;
  state: UpdateState;
  firstAvailableAt: Date | null;
  installedAt: Date | null;
}

interface TargetState {
  state: UpdateState;
  firstAvailableAt: Date | null;
  installedAt: Date | null;
  resultCode: number | null;
  hresult: number | null;
  rebootRequired: boolean;
}

interface PendingEvent {
  updateId: string;
  eventType: UpdateEventType;
  occurredAt: Date;
  details: Record<string, unknown> | null;
}

@Injectable()
export class CheckinService {
  private readonly logger = new Logger(CheckinService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Verarbeitet einen Snapshot. Jeder Snapshot laeuft in einer eigenen
   * Transaktion, damit ein fehlerhafter Eintrag aus einer Offline-Nachreichung
   * die uebrigen nicht mitreisst.
   */
  async ingest(device: Device, snapshot: SnapshotDto): Promise<SnapshotResultDto> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const collectedAt = new Date(snapshot.collectedAt);

        const checkinId = await this.insertCheckin(manager, device, snapshot, collectedAt);
        if (checkinId === null) {
          // Der Snapshot war schon einmal da. Genau dafuer ist die
          // Eindeutigkeitsbedingung auf snapshot_id gedacht.
          return { snapshotId: snapshot.snapshotId, outcome: SnapshotOutcome.Duplicate };
        }

        const catalog = this.mergeCatalogEntries(snapshot);
        const catalogIds = await this.upsertCatalog(manager, catalog);

        const existing = await this.loadExistingStates(manager, device.id);
        const { targets, events } = this.computeTransitions(
          snapshot,
          collectedAt,
          catalogIds,
          existing,
        );

        await this.writeStates(manager, device.id, targets, collectedAt);
        await this.writeEvents(manager, device.id, events);
        await this.touchDevice(manager, device.id, snapshot, collectedAt);

        return { snapshotId: snapshot.snapshotId, outcome: SnapshotOutcome.Accepted };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Snapshot ${snapshot.snapshotId} von Geraet ${device.id} abgelehnt: ${message}`,
      );
      return {
        snapshotId: snapshot.snapshotId,
        outcome: SnapshotOutcome.Rejected,
        error: message,
      };
    }
  }

  /**
   * Legt den Check-in an. Gibt `null` zurueck, wenn die `snapshot_id` bereits
   * existiert — `ON CONFLICT DO NOTHING` statt einer Vorabpruefung, damit auch
   * zwei gleichzeitig eintreffende Wiederholungen sauber auseinandergehen.
   */
  private async insertCheckin(
    manager: EntityManager,
    device: Device,
    snapshot: SnapshotDto,
    collectedAt: Date,
  ): Promise<string | null> {
    const rows: Array<{ id: string }> = await manager.query(
      `INSERT INTO device_checkins
         (device_id, snapshot_id, collected_at, agent_version, update_source,
          wsus_server_url, pending_reboot, raw_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (snapshot_id) DO NOTHING
       RETURNING id`,
      [
        device.id,
        snapshot.snapshotId,
        collectedAt,
        snapshot.agentVersion,
        snapshot.updateSource.source,
        snapshot.updateSource.wsusServerUrl ?? null,
        snapshot.pendingReboot,
        snapshot.updateSource.registeredServices || snapshot.updateSource.mdmEnrolled !== undefined
          ? {
              registeredServices: snapshot.updateSource.registeredServices ?? [],
              useWuServer: snapshot.updateSource.useWuServer ?? null,
              mdmEnrolled: snapshot.updateSource.mdmEnrolled ?? null,
            }
          : null,
      ],
    );

    return rows.length > 0 ? rows[0].id : null;
  }

  /**
   * Fuehrt die Metadaten aus Verfuegbar-Liste und Historie zusammen. Die
   * Verfuegbar-Liste gewinnt, weil sie die vollstaendigeren Angaben traegt;
   * Historieneintraege liefern oft nur Titel und Ergebniscode.
   */
  private mergeCatalogEntries(snapshot: SnapshotDto): CatalogEntry[] {
    const merged = new Map<string, CatalogEntry>();

    for (const entry of snapshot.history) {
      if (!entry.updateId) continue;
      merged.set(entry.updateId, this.catalogFromHistory(entry));
    }

    // Nach der Historie eingetragen, damit die reichhaltigeren Angaben gewinnen.
    for (const update of snapshot.availableUpdates) {
      merged.set(update.updateId, this.catalogFromAvailable(update));
    }

    return [...merged.values()];
  }

  private catalogFromAvailable(update: AvailableUpdateDto): CatalogEntry {
    return {
      updateId: update.updateId,
      revisionNumber: update.revisionNumber ?? null,
      kbArticle: update.kbArticle ?? null,
      title: update.title,
      severity: update.severity ?? null,
      categories: update.categories ?? [],
      isSecurity: update.isSecurity ?? false,
      msrcNumber: update.msrcNumber ?? null,
      sizeBytes: update.sizeBytes ?? null,
      supportUrl: update.supportUrl ?? null,
    };
  }

  private catalogFromHistory(entry: HistoryEntryDto): CatalogEntry {
    return {
      updateId: entry.updateId as string,
      revisionNumber: entry.revisionNumber ?? null,
      kbArticle: entry.kbArticle ?? null,
      title: entry.title,
      severity: null,
      categories: [],
      isSecurity: false,
      msrcNumber: null,
      sizeBytes: null,
      supportUrl: entry.supportUrl ?? null,
    };
  }

  /**
   * Schreibt den Katalog fort und liefert die Zuordnung WU-UpdateID → interne
   * uuid. Vorhandene Angaben werden nur ueberschrieben, wenn der neue Snapshot
   * tatsaechlich etwas mitbringt — ein Historieneintrag soll die reichhaltigen
   * Metadaten aus einer frueheren Verfuegbar-Meldung nicht ausduennen.
   */
  private async upsertCatalog(
    manager: EntityManager,
    entries: CatalogEntry[],
  ): Promise<Map<string, string>> {
    if (entries.length === 0) {
      return new Map();
    }

    const { text, params } = buildValuesClause(
      entries.map((e) => [
        e.updateId,
        e.revisionNumber,
        e.kbArticle,
        e.title,
        e.severity,
        e.categories,
        e.isSecurity,
        e.msrcNumber,
        e.sizeBytes,
        e.supportUrl,
      ]),
    );

    const rows: Array<{ id: string; update_id: string }> = await manager.query(
      `INSERT INTO updates
         (update_id, revision_number, kb_article, title, severity, categories,
          is_security, msrc_number, size_bytes, support_url)
       VALUES ${text}
       ON CONFLICT (update_id) DO UPDATE SET
         revision_number = COALESCE(EXCLUDED.revision_number, updates.revision_number),
         kb_article      = COALESCE(EXCLUDED.kb_article, updates.kb_article),
         title           = EXCLUDED.title,
         severity        = COALESCE(EXCLUDED.severity, updates.severity),
         categories      = CASE WHEN cardinality(EXCLUDED.categories) > 0
                                THEN EXCLUDED.categories ELSE updates.categories END,
         is_security     = updates.is_security OR EXCLUDED.is_security,
         msrc_number     = COALESCE(EXCLUDED.msrc_number, updates.msrc_number),
         size_bytes      = COALESCE(EXCLUDED.size_bytes, updates.size_bytes),
         support_url     = COALESCE(EXCLUDED.support_url, updates.support_url)
       RETURNING id, update_id`,
      params,
    );

    return new Map(rows.map((r) => [r.update_id, r.id]));
  }

  private async loadExistingStates(
    manager: EntityManager,
    deviceId: string,
  ): Promise<Map<string, ExistingState>> {
    const rows: Array<{
      update_id: string;
      state: UpdateState;
      first_available_at: Date | null;
      installed_at: Date | null;
    }> = await manager.query(
      `SELECT update_id, state, first_available_at, installed_at
         FROM device_update_states
        WHERE device_id = $1`,
      [deviceId],
    );

    return new Map(
      rows.map((r) => [
        r.update_id,
        {
          updateId: r.update_id,
          state: r.state,
          firstAvailableAt: r.first_available_at,
          installedAt: r.installed_at,
        },
      ]),
    );
  }

  /**
   * Leitet aus dem Snapshot den neuen Sollzustand und die daraus folgenden
   * Ereignisse ab.
   *
   * Reihenfolge der Wahrheit:
   *  1. Die Verfuegbar-Liste ist vollstaendig — was dort fehlt, ist offen nicht mehr.
   *  2. Die Historie erklaert, *warum* etwas fehlt (installiert oder gescheitert).
   *  3. Bleibt nach beidem ein vorher offenes Update uebrig, ist es
   *     verschwunden, ohne installiert worden zu sein — also abgeloest.
   */
  private computeTransitions(
    snapshot: SnapshotDto,
    collectedAt: Date,
    catalogIds: Map<string, string>,
    existing: Map<string, ExistingState>,
  ): { targets: Map<string, TargetState>; events: PendingEvent[] } {
    const targets = new Map<string, TargetState>();
    const events: PendingEvent[] = [];

    // --- 1. Alles, was aktuell offen ist ------------------------------------
    for (const update of snapshot.availableUpdates) {
      const id = catalogIds.get(update.updateId);
      if (!id) continue;

      const before = existing.get(id);
      targets.set(id, {
        state: UpdateState.Available,
        firstAvailableAt: before?.firstAvailableAt ?? collectedAt,
        installedAt: before?.installedAt ?? null,
        resultCode: null,
        hresult: null,
        rebootRequired: update.rebootRequired ?? false,
      });

      if (!before || before.state !== UpdateState.Available) {
        events.push({
          updateId: id,
          eventType: UpdateEventType.Appeared,
          occurredAt: collectedAt,
          details: {
            severity: update.severity ?? null,
            kbArticle: update.kbArticle ?? null,
            previousState: before?.state ?? null,
          },
        });
      }
    }

    // --- 2. Was die Historie erklaert ---------------------------------------
    for (const entry of this.latestHistoryPerUpdate(snapshot.history)) {
      const id = entry.updateId ? catalogIds.get(entry.updateId) : undefined;
      if (!id) continue;

      const occurredAt = new Date(entry.occurredAt);
      const succeeded =
        entry.resultCode === OperationResultCode.Succeeded ||
        entry.resultCode === OperationResultCode.SucceededWithErrors;

      events.push({
        updateId: id,
        eventType: succeeded ? UpdateEventType.Installed : UpdateEventType.Failed,
        occurredAt,
        details: {
          operation: entry.operation,
          resultCode: entry.resultCode,
          hresult: entry.hresult,
        },
      });

      const stillOffered = targets.get(id);
      if (stillOffered) {
        // Wird trotz Historieneintrag weiterhin angeboten — meist eine neue
        // Revision. Der offene Zustand bleibt, der Ergebniscode wird vermerkt.
        stillOffered.resultCode = entry.resultCode;
        stillOffered.hresult = entry.hresult;
        continue;
      }

      const before = existing.get(id);
      targets.set(id, {
        state: succeeded ? UpdateState.Installed : UpdateState.Failed,
        firstAvailableAt: before?.firstAvailableAt ?? null,
        installedAt: succeeded ? occurredAt : (before?.installedAt ?? null),
        resultCode: entry.resultCode,
        hresult: entry.hresult,
        rebootRequired: false,
      });
    }

    // --- 3. Verschwunden ohne Erklaerung ------------------------------------
    for (const [id, before] of existing) {
      if (before.state !== UpdateState.Available) continue;
      if (targets.has(id)) continue;

      targets.set(id, {
        state: UpdateState.Superseded,
        firstAvailableAt: before.firstAvailableAt,
        installedAt: before.installedAt,
        resultCode: null,
        hresult: null,
        rebootRequired: false,
      });
      events.push({
        updateId: id,
        eventType: UpdateEventType.Disappeared,
        occurredAt: collectedAt,
        details: { reason: 'nicht mehr in der Verfuegbar-Liste, keine Installation gemeldet' },
      });
    }

    return { targets, events };
  }

  /**
   * Die Historie kann mehrere Versuche desselben Updates enthalten. Fuer den
   * Zustand zaehlt der letzte; alle Versuche landen trotzdem als Ereignisse in
   * der Zeitreihe, damit wiederholte Fehlschlaege sichtbar bleiben.
   */
  private latestHistoryPerUpdate(history: HistoryEntryDto[]): HistoryEntryDto[] {
    const relevant = history.filter(
      (h) => h.updateId && h.operation === HistoryOperation.Installation,
    );
    return [...relevant].sort(
      (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
  }

  private async writeStates(
    manager: EntityManager,
    deviceId: string,
    targets: Map<string, TargetState>,
    collectedAt: Date,
  ): Promise<void> {
    if (targets.size === 0) return;

    const { text, params } = buildValuesClause(
      [...targets.entries()].map(([updateId, t]) => [
        deviceId,
        updateId,
        t.state,
        t.firstAvailableAt,
        t.installedAt,
        t.resultCode,
        t.hresult,
        t.rebootRequired,
        collectedAt,
      ]),
    );

    await manager.query(
      `INSERT INTO device_update_states
         (device_id, update_id, state, first_available_at, installed_at,
          result_code, hresult, reboot_required, last_reported_at)
       VALUES ${text}
       ON CONFLICT (device_id, update_id) DO UPDATE SET
         state              = EXCLUDED.state,
         first_available_at = COALESCE(device_update_states.first_available_at,
                                       EXCLUDED.first_available_at),
         installed_at       = COALESCE(EXCLUDED.installed_at, device_update_states.installed_at),
         result_code        = COALESCE(EXCLUDED.result_code, device_update_states.result_code),
         hresult            = COALESCE(EXCLUDED.hresult, device_update_states.hresult),
         reboot_required    = EXCLUDED.reboot_required,
         last_reported_at   = EXCLUDED.last_reported_at`,
      params,
    );
  }

  private async writeEvents(
    manager: EntityManager,
    deviceId: string,
    events: PendingEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    const { text, params } = buildValuesClause(
      events.map((e) => [deviceId, e.updateId, e.eventType, e.occurredAt, e.details]),
    );

    await manager.query(
      `INSERT INTO device_update_events
         (device_id, update_id, event_type, occurred_at, details)
       VALUES ${text}`,
      params,
    );
  }

  /**
   * `last_seen_at` nur vorwaerts bewegen: bei einer Offline-Nachreichung
   * koennte sonst ein alter Snapshot einen neueren Zeitstempel zuruecksetzen.
   */
  private async touchDevice(
    manager: EntityManager,
    deviceId: string,
    snapshot: SnapshotDto,
    collectedAt: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE devices SET
         last_seen_at  = GREATEST(COALESCE(last_seen_at, $2), $2),
         hostname      = $3,
         os_name       = COALESCE($4, os_name),
         os_version    = COALESCE($5, os_version),
         os_build      = COALESCE($6, os_build),
         agent_version = $7,
         updated_at    = now()
       WHERE id = $1`,
      [
        deviceId,
        collectedAt,
        snapshot.host.hostname,
        snapshot.host.osName ?? null,
        snapshot.host.osVersion ?? null,
        snapshot.host.osBuild ?? null,
        snapshot.agentVersion,
      ],
    );
  }
}
