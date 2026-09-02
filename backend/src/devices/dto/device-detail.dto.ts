import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DeviceStatus, UpdateEventType, UpdateSource, UpdateState } from '../../database/enums.js';

export class DeviceUpdateDto {
  updateId: string;
  wuUpdateId: string;
  kbArticle: string | null;
  title: string;
  severity: string | null;
  categories: string[];
  isSecurity: boolean;
  sizeBytes: string | null;
  supportUrl: string | null;
  state: UpdateState;
  firstAvailableAt: string | null;
  installedAt: string | null;
  resultCode: number | null;
  hresult: number | null;
  rebootRequired: boolean;
  lastReportedAt: string;
}

export class DeviceCheckinDto {
  id: string;
  collectedAt: string;
  reportedAt: string;
  agentVersion: string | null;
  updateSource: UpdateSource;
  wsusServerUrl: string | null;
  pendingReboot: boolean;
}

export class DeviceDetailDto {
  id: string;
  hostname: string;
  adDn: string | null;
  adOu: string | null;
  adObjectGuid: string | null;
  osName: string | null;
  osVersion: string | null;
  osBuild: string | null;
  status: DeviceStatus;
  agentVersion: string | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  archivedAt: string | null;
  archivedReason: string | null;

  /** Alle aktuellen Zustaende, offene zuerst. */
  updates: DeviceUpdateDto[];

  /** Die letzten Check-ins, neueste zuerst. */
  checkins: DeviceCheckinDto[];
}

export class ArchiveDeviceDto {
  @IsString()
  @MaxLength(512)
  @IsOptional()
  reason?: string;
}

export class TimelineQueryDto {
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  limit: number = 100;

  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  @IsOptional()
  offset: number = 0;
}

export class TimelineEntryDto {
  id: string;
  eventType: UpdateEventType;
  occurredAt: string;
  reportedAt: string;
  kbArticle: string | null;
  title: string;
  isSecurity: boolean;
  details: Record<string, unknown> | null;
}

export class TimelineDto {
  items: TimelineEntryDto[];
  total: number;
}
