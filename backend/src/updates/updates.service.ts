import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SqlParams } from '../common/sql-params.js';
import { UpdateState } from '../database/enums.js';
import {
  UpdateDeviceDto,
  UpdateDevicesDto,
  UpdateListDto,
  UpdateListItemDto,
  UpdateQueryDto,
} from './dto/update-query.dto.js';

const SORT_COLUMNS: Record<string, string> = {
  affectedDevices: 'affected_devices',
  title: 'u.title',
  kbArticle: 'u.kb_article',
  firstSeenAt: 'u.first_seen_at',
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
};

@Injectable()
export class UpdatesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(query: UpdateQueryDto): Promise<UpdateListDto> {
    const params = new SqlParams();
    const conditions: string[] = [];

    if (query.search) {
      const term = params.add(`%${query.search}%`);
      conditions.push(`(u.title ILIKE ${term} OR u.kb_article ILIKE ${term})`);
    }

    if (query.isSecurity !== undefined) {
      conditions.push(`u.is_security = ${params.add(query.isSecurity)}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Nach der Gruppierung, weil sich der Filter auf eine Aggregatgroesse
    // bezieht.
    const having = query.onlyOpen ? 'HAVING count(*) FILTER (WHERE s.state = \'available\') > 0' : '';

    const sortColumn = SORT_COLUMNS[query.sortBy] ?? SORT_COLUMNS.affectedDevices;
    const direction = query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const limit = params.add(query.limit);
    const offset = params.add((query.page - 1) * query.limit);

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT u.id, u.update_id, u.kb_article, u.title, u.severity, u.categories,
              u.is_security, u.msrc_number, u.size_bytes, u.support_url, u.first_seen_at,
              count(*) FILTER (WHERE s.state = 'available') AS affected_devices,
              count(*) FILTER (WHERE s.state = 'installed') AS installed_devices,
              count(*) FILTER (WHERE s.state = 'failed')    AS failed_devices
         FROM updates u
         LEFT JOIN device_update_states s ON s.update_id = u.id
        ${where}
        GROUP BY u.id
        ${having}
        ORDER BY ${sortColumn} ${direction} NULLS LAST, u.title ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params.values,
    );

    const countParams = new SqlParams();
    const countConditions: string[] = [];
    if (query.search) {
      const term = countParams.add(`%${query.search}%`);
      countConditions.push(`(u.title ILIKE ${term} OR u.kb_article ILIKE ${term})`);
    }
    if (query.isSecurity !== undefined) {
      countConditions.push(`u.is_security = ${countParams.add(query.isSecurity)}`);
    }
    const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';

    // Die Zaehlung muss dieselbe Gruppierung durchlaufen, sonst zaehlt sie bei
    // gesetztem onlyOpen zu viel.
    const totals: Array<{ total: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS total FROM (
         SELECT u.id
           FROM updates u
           LEFT JOIN device_update_states s ON s.update_id = u.id
          ${countWhere}
          GROUP BY u.id
          ${having}
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

  private toListItem(row: Record<string, unknown>): UpdateListItemDto {
    return {
      id: row.id as string,
      wuUpdateId: row.update_id as string,
      kbArticle: (row.kb_article as string | null) ?? null,
      title: row.title as string,
      severity: (row.severity as string | null) ?? null,
      categories: (row.categories as string[] | null) ?? [],
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
        WHERE s.update_id = $1
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
      lastSeenAt: toIso(row.last_seen_at),
    }));

    return { items, unaffected: Number(unaffected[0]?.total ?? 0) };
  }
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
