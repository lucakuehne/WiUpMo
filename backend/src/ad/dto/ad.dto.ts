import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdSyncStatus, AdSyncTrigger } from '../../database/enums.js';

export class AdSyncRunDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: AdSyncTrigger;
  devicesFound: number;
  devicesCreated: number;
  devicesArchived: number;
  status: AdSyncStatus;
  error: string | null;
}

export class AdSyncResultDto {
  id: string;
  status: AdSyncStatus;
  devicesFound: number;
  devicesCreated: number;
  devicesArchived: number;

  /** Geraete, die im AD wieder aufgetaucht sind. Nicht im Protokoll gespeichert. */
  devicesReactivated: number;

  error: string | null;
}

export class AdStatusDto {
  /** `false`, solange AD_URL und AD_BASE_DN fehlen. */
  enabled: boolean;

  url: string;
  baseDn: string;
  bindDn: string;

  /** Das Passwort selbst wird nie ausgeliefert. */
  bindPasswordSet: boolean;

  filter: string;
  intervalMinutes: number;
  running: boolean;
  lastRun: AdSyncRunDto | null;
}

export class SyncRunsQueryDto {
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit: number = 25;
}
