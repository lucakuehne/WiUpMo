import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isPostRebootPending } from '../common/post-reboot.js';
import { SqlParams, toCsv } from '../common/sql-params.js';
import {
  UPDATE_CLASSIFICATIONS,
  UPDATE_CLASSIFICATION_LABELS,
  UpdateClassification,
  classificationSql,
} from '../common/update-classification.js';
import { UpdateState } from '../database/enums.js';
import {
  UpdateClassificationCountDto,
  UpdateDeviceDto,
  UpdateDevicesDto,
  UpdateFilterDto,
  UpdateListDto,
  UpdateListItemDto,
  UpdateQueryDto,
} from './dto/update-query.dto.js';

const SORT_COLUMNS: Record<string, string> = {
  affectedDevices: 'affected_devices',
  installedDevices: 'installed_devices',
  failedDevices: 'failed_devices',
  title: 'u.title',
  kbArticle: 'u.kb_article',
  firstSeenAt: 'u.first_seen_at',
  sizeBytes: 'u.size_bytes',
  // Nach Dringlichkeit statt alphabetisch: "Critical" vor "Important" vor
  // "Moderate" vor "Low". Alphabetisch stuende "Critical" vor "Low" vor
  // "Moderate" — eine Reihenfolge, die niemandem hilft.
  severity: `CASE lower(coalesce(u.severity, ''))
               WHEN 'critical'  THEN 0
               WHEN 'important' THEN 1
               WHEN 'moderate'  THEN 2
               WHEN 'low'       THEN 3
               ELSE 4
             END`,
  // In der Reihenfolge des Installationsdialogs, Sicherheitsupdates zuerst.
  classification: `array_position(ARRAY[${UPDATE_CLASSIFICATIONS.map((c) => `'${c}'`).join(', ')}]::text[], ${classificationSql('u')})`,
};

/**
 * Zustaende, aber nur von aktiven Geraeten.
 *
 * Als `EXISTS` am Verbund statt als Bedingung im `WHERE`: Der Verbund bleibt
 * damit ein LEFT JOIN, und ein Update ohne jeden passenden Zustand faellt nicht
 * aus dem Katalog. Archivierte Geraete verbinden sich schlicht nicht, ihre
 * Zustaende zaehlen dadurch nirgends mit.
 *
 * Ohne diese Einschraenkung wies der Katalog Geraete aus, die in der
 * Geraeteliste gar nicht mehr auftauchen — und ein Update, das nur noch auf
 * archivierten Geraeten offen ist, stand weiterhin als offen darin.
 */
const ACTIVE_STATES = `
  LEFT JOIN device_update_states s
         ON s.update_id = u.id
        AND EXISTS (
          SELECT 1 FROM devices d WHERE d.id = s.device_id AND d.status = 'active'
        )
`;

/** Spalten einer Katalogzeile; die Abfrage gruppiert nach `u.id`. */
const ITEM_COLUMNS = `
  u.id, u.update_id, u.kb_article, u.title, u.severity, u.categories, u.is_security,
  u.msrc_number, u.size_bytes, u.support_url, u.first_seen_at,
  ${classificationSql('u')} AS classification,
  count(*) FILTER (WHERE s.state = 'available') AS affected_devices,
  count(*) FILTER (WHERE s.state = 'installed') AS installed_devices,
  count(*) FILTER (WHERE s.state = 'failed')    AS failed_devices
`;

/** Bedingungen auf den Katalog (WHERE) und auf die Zaehlungen je Update (HAVING). */
interface FilterSql {
  where: string;
  having: string;
}

@Injectable()
export class UpdatesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(query: UpdateQueryDto): Promise<UpdateListDto> {
    const params = new SqlParams();
    const { where, having } = this.filterSql(query, params);

    const sortColumn = SORT_COLUMNS[query.sortBy] ?? SORT_COLUMNS.affectedDevices;
    const direction = query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const limit = params.add(query.limit);
    const offset = params.add((query.page - 1) * query.limit);

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${ITEM_COLUMNS}
         FROM updates u
         ${ACTIVE_STATES}
        ${where}
        GROUP BY u.id
        ${having}
        ORDER BY ${sortColumn} ${direction} NULLS LAST, u.title ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params.values,
    );

    // Die Zaehlung muss dieselbe Gruppierung durchlaufen, sonst zaehlt sie bei
    // einem Zustandsfilter zu viel.
    const countParams = new SqlParams();
    const count = this.filterSql(query, countParams);
    const totals: Array<{ total: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS total FROM (
         SELECT u.id
           FROM updates u
           ${ACTIVE_STATES}
          ${count.where}
          GROUP BY u.id
          ${count.having}
       ) AS filtered`,
      countParams.values,
    );

    return {
      items: rows.map((row) => this.toListItem(row)),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Updates je Typ unter allen uebrigen Filtern — fuer die Navigation. Der
   * Typfilter selbst bleibt aussen vor, sonst stuende neben jedem anderen Typ
   * eine Null. Alle Typen kommen mit, in fester Reihenfolge.
   */
  async classifications(filter: UpdateFilterDto): Promise<UpdateClassificationCountDto[]> {
    const params = new SqlParams();
    const { where, having } = this.filterSql({ ...filter, classification: undefined }, params);

    const rows: Array<{ classification: UpdateClassification; updates: string }> = await this.dataSource.query(
      `SELECT classification, count(*)::text AS updates FROM (
         SELECT ${classificationSql('u')} AS classification
           FROM updates u
           ${ACTIVE_STATES}
          ${where}
          GROUP BY u.id
          ${having}
       ) AS filtered
       GROUP BY classification`,
      params.values,
    );

    const counts = new Map(rows.map((row) => [row.classification, Number(row.updates)]));
    return UPDATE_CLASSIFICATIONS.map((classification) => ({
      classification,
      updates: counts.get(classification) ?? 0,
    }));
  }

  /** Ein Katalogeintrag mit denselben Zaehlungen wie in der Liste. */
  async get(id: string): Promise<UpdateListItemDto> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${ITEM_COLUMNS}
         FROM updates u
         ${ACTIVE_STATES}
        WHERE u.id = $1
        GROUP BY u.id`,
      [id],
    );
    if (rows.length === 0) {
      throw new NotFoundException('Update nicht gefunden.');
    }

    return this.toListItem(rows[0]);
  }

  async exportCsv(query: UpdateQueryDto): Promise<string> {
    const { items } = await this.list({ ...query, page: 1, limit: 50_000 });

    return toCsv(
      [
        'KB',
        'Titel',
        'Typ',
        'Einstufung',
        'Kategorien',
        'Grösse (Bytes)',
        'Offen auf',
        'Installiert auf',
        'Gescheitert auf',
        'Erstmals gesehen',
        'Update-ID',
      ],
      items.map((item) => [
        item.kbArticle ? `KB${item.kbArticle}` : null,
        item.title,
        UPDATE_CLASSIFICATION_LABELS[item.classification],
        item.severity,
        item.categories.join(', '),
        item.sizeBytes,
        item.affectedDevices,
        item.installedDevices,
        item.failedDevices,
        item.firstSeenAt,
        item.wuUpdateId,
      ]),
    );
  }

  /**
   * Baut die Filter in die Platzhalter von `params` ein.
   *
   * Der Zustand bezieht sich auf die Zaehlungen je Update und steht deshalb
   * nach der Gruppierung.
   */
  private filterSql(filter: UpdateFilterDto, params: SqlParams): FilterSql {
    const conditions: string[] = [];

    if (filter.search) {
      const term = params.add(`%${filter.search}%`);
      conditions.push(`(u.title ILIKE ${term} OR u.kb_article ILIKE ${term})`);
    }

    if (filter.isSecurity !== undefined) {
      conditions.push(`u.is_security = ${params.add(filter.isSecurity)}`);
    }

    if (filter.classification) {
      conditions.push(`${classificationSql('u')} = ${params.add(filter.classification)}`);
    }

    if (filter.severity === 'none') {
      conditions.push(`coalesce(u.severity, '') = ''`);
    } else if (filter.severity) {
      conditions.push(`lower(u.severity) = ${params.add(filter.severity)}`);
    }

    const having = {
      open: `HAVING count(*) FILTER (WHERE s.state = 'available') > 0`,
      failed: `HAVING count(*) FILTER (WHERE s.state = 'failed') > 0`,
      closed: `HAVING count(*) FILTER (WHERE s.state = 'available') = 0`,
    };

    return {
      where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
      having: filter.state ? having[filter.state] : '',
    };
  }

  private toListItem(row: Record<string, unknown>): UpdateListItemDto {
    return {
      id: row.id as string,
      wuUpdateId: row.update_id as string,
      kbArticle: (row.kb_article as string | null) ?? null,
      title: row.title as string,
      severity: (row.severity as string | null) ?? null,
      categories: (row.categories as string[] | null) ?? [],
      classification: row.classification as UpdateClassification,
      isSecurity: row.is_security as boolean,
      msrcNumber: (row.msrc_number as string | null) ?? null,
      sizeBytes: (row.size_bytes as string | null) ?? null,
      supportUrl: (row.support_url as string | null) ?? null,
      firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : null,
      affectedDevices: Number(row.affected_devices),
      installedDevices: Number(row.installed_devices),
      failedDevices: Number(row.failed_devices),
    };
  }

  async devices(updateId: string): Promise<UpdateDevicesDto> {
    const exists: Array<{ id: string }> = await this.dataSource.query(
      'SELECT id FROM updates WHERE id = $1',
      [updateId],
    );
    if (exists.length === 0) {
      throw new NotFoundException('Update nicht gefunden.');
    }

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT d.id AS device_id, d.hostname, d.ad_ou, d.last_seen_at,
              s.state, s.first_available_at, s.installed_at, s.hresult
         FROM device_update_states s
         JOIN devices d ON d.id = s.device_id
        WHERE s.update_id = $1 AND d.status = 'active'
        ORDER BY
          CASE s.state WHEN 'available' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
          d.hostname ASC`,
      [updateId],
    );

    const unaffected: Array<{ total: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS total
         FROM devices d
        WHERE d.enrolled_at IS NOT NULL
          AND d.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM device_update_states s
             WHERE s.device_id = d.id AND s.update_id = $1
          )`,
      [updateId],
    );

    const items: UpdateDeviceDto[] = rows.map((row) => ({
      deviceId: row.device_id as string,
      hostname: row.hostname as string,
      adOu: (row.ad_ou as string | null) ?? null,
      state: row.state as UpdateState,
      firstAvailableAt: toIso(row.first_available_at),
      installedAt: toIso(row.installed_at),
      hresult: (row.hresult as number | null) ?? null,
      awaitingReboot: row.state === UpdateState.Available && isPostRebootPending(row.hresult as number | null),
      lastSeenAt: toIso(row.last_seen_at),
    }));

    return { items, unaffected: Number(unaffected[0]?.total ?? 0) };
  }
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
