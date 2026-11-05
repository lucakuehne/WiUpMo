import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, ValidateNested } from 'class-validator';
import { TREND_INTERVALS, type TrendInterval } from '../reports/dto/reports.dto.js';

/** Die Zeitraeume, die das Dashboard anbietet, in Tagen. */
export const DASHBOARD_RANGE_DAYS = [1, 7, 30, 90, 180, 365] as const;

export class DashboardPreferencesDto {
  @IsInt()
  @IsIn(DASHBOARD_RANGE_DAYS)
  rangeDays: number;

  @IsIn(TREND_INTERVALS)
  interval: TrendInterval;
}

/** Jeder Abschnitt ist optional; ein gesendeter ersetzt den gespeicherten. */
export class PreferencesDto {
  @ValidateNested()
  @Type(() => DashboardPreferencesDto)
  @IsOptional()
  dashboard?: DashboardPreferencesDto;
}

export class PreferencesViewDto {
  /** Null, solange der Benutzer nichts gewaehlt hat. */
  dashboard: DashboardPreferencesDto | null;
}
