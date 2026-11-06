import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AgentProblemDeviceDto, AgentProblemDto } from './agent-problems.dto.js';
import { TRANSMISSION_FAILURE, problemKey } from './problem-key.js';

interface LogRow {
  device_id: string;
  hostname: string;
  at: Date;
  level: string | null;
  message: string;
}

/**
 * Was die Agents zuletzt an Warnungen und Fehlern gemeldet haben, ueber die
 * ganze Flotte zusammengefasst.
 *
 * Quelle ist die Selbstauskunft aus dem juengsten Check-in jedes Geraets: Sie
 * traegt die letzten Eintraege seines Protokolls. Am einzelnen Geraet steht
 * das in der Karte „Agent-Zustand"; hier zeigt sich, ob dieselbe Stoerung auf
 * vielen Geraeten auftritt — dann liegt die Ursache selten beim Geraet.
 */
@Injectable()
export class AgentProblemsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(days: number): Promise<AgentProblemDto[]> {
    // Agents vor 0.6.0 melden keine Liste, nur die juengste Stoerung.
    const rows: LogRow[] = await this.dataSource.query(
      `SELECT d.id AS device_id, d.hostname, l.at, l.level, l.message
         FROM devices d
         CROSS JOIN LATERAL (
           SELECT (x->>'at')::timestamptz AS at, x->>'level' AS level, x->>'message' AS message
             FROM jsonb_array_elements(d.agent_diagnostics->'recentLogs') AS x
            WHERE jsonb_typeof(d.agent_diagnostics->'recentLogs') = 'array'
           UNION ALL
           SELECT (d.agent_diagnostics->>'lastErrorAt')::timestamptz, 'warning', d.agent_diagnostics->>'lastError'
            WHERE jsonb_typeof(d.agent_diagnostics->'recentLogs') IS DISTINCT FROM 'array'
              AND d.agent_diagnostics->>'lastErrorAt' IS NOT NULL
         ) AS l
        WHERE d.status = 'active'
          AND d.enrolled_at IS NOT NULL
          AND l.message IS NOT NULL
          AND l.at >= now() - make_interval(days => $1)
        ORDER BY l.at DESC`,
      [days],
    );

    const problems = new Map<string, { problem: AgentProblemDto; byDevice: Map<string, AgentProblemDeviceDto> }>();

    // Neueste zuerst: Was als Erstes eintrifft, ist je Gruppe und Geraet das Juengste.
    for (const row of rows) {
      if (row.message.startsWith(TRANSMISSION_FAILURE)) continue;

      const key = problemKey(row.message);
      const at = row.at.toISOString();
      const isError = row.level?.toLowerCase() === 'error';

      let group = problems.get(key);
      if (!group) {
        group = {
          problem: {
            key,
            message: row.message,
            level: 'warning',
            devices: 0,
            occurrences: 0,
            lastAt: at,
            entries: [],
          },
          byDevice: new Map(),
        };
        problems.set(key, group);
      }

      group.problem.occurrences++;
      if (isError) group.problem.level = 'error';

      const device = group.byDevice.get(row.device_id);
      if (device) {
        device.occurrences++;
      } else {
        group.byDevice.set(row.device_id, {
          deviceId: row.device_id,
          hostname: row.hostname,
          lastAt: at,
          occurrences: 1,
          message: row.message,
        });
      }
    }

    return [...problems.values()]
      .map(({ problem, byDevice }) => ({
        ...problem,
        devices: byDevice.size,
        entries: [...byDevice.values()],
      }))
      .sort((a, b) => b.devices - a.devices || b.occurrences - a.occurrences || b.lastAt.localeCompare(a.lastAt));
  }
}
