import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PreferencesDto, PreferencesViewDto } from './preferences.dto.js';

/**
 * Auswahlen, die sich ein Benutzer ueber die Sitzung hinaus merkt — auf jedem
 * Rechner, an dem er sich anmeldet. Nicht im Browser gespeichert, weil das an
 * einem anderen Arbeitsplatz wieder von vorn begaenne.
 */
@Injectable()
export class PreferencesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get(username: string): Promise<PreferencesViewDto> {
    const rows: Array<{ preferences: Record<string, unknown> }> = await this.dataSource.query(
      'SELECT preferences FROM user_preferences WHERE username = lower($1)',
      [username],
    );
    return this.toView(rows[0]?.preferences ?? {});
  }

  /** Fuehrt die gesendeten Abschnitte mit den gespeicherten zusammen. */
  async update(username: string, dto: PreferencesDto): Promise<PreferencesViewDto> {
    const changes = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));

    const rows: Array<{ preferences: Record<string, unknown> }> = await this.dataSource.query(
      `INSERT INTO user_preferences (username, preferences)
       VALUES (lower($1), $2::jsonb)
       ON CONFLICT (username) DO UPDATE
         SET preferences = user_preferences.preferences || EXCLUDED.preferences,
             updated_at  = now()
       RETURNING preferences`,
      [username, JSON.stringify(changes)],
    );
    return this.toView(rows[0]?.preferences ?? {});
  }

  private toView(preferences: Record<string, unknown>): PreferencesViewDto {
    return { dashboard: (preferences.dashboard as PreferencesViewDto['dashboard']) ?? null };
  }
}
