import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { UpdateSource } from '../../database/enums.js';

const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

export class SummaryDto {
  devicesTotal: number;
  devicesActive: number;
  devicesArchived: number;

  /** Geraete mit installiertem Agent. */
  devicesEnrolled: number;

  /** Im AD bekannt, aber ohne Agent — die Deployment-Luecke. */
  devicesWithoutAgent: number;

  /** Registriert, aber seit laenger als dem Schwellwert stumm. */
  staleAgents: number;

  devicesWithOpenSecurity: number;

  /** Sicherheitsrelevantes Update laenger offen als der Schwellwert. */
  devicesCritical: number;

  devicesPendingReboot: number;

  openUpdatesTotal: number;
  openSecurityUpdatesTotal: number;

  /** Median ueber alle Geraete mit mindestens einem offenen Update. */
  medianPatchAgeDays: number | null;

  /** Die verwendeten Schwellwerte, damit das Frontend sie anzeigen kann. */
  staleAgentDays: number;
  criticalOpenDays: number;
}

export class UpdateSourceCountDto {
  source: UpdateSource;
  devices: number;

  /** Median-Patch-Alter der Geraete dieser Quelle. */
  medianPatchAgeDays: number | null;
}

export class SourceChangeDto {
  deviceId: string;
  hostname: string;
  previousSource: UpdateSource;
  currentSource: UpdateSource;
  changedAt: string;
}

export class UpdateSourcesReportDto {
  distribution: UpdateSourceCountDto[];

  /** Geraete, deren Quelle sich zuletzt geaendert hat — der Migrationsfortschritt. */
  changes: SourceChangeDto[];
}

export class PatchAgeBucketDto {
  /** Untergrenze in Tagen, `null` fuer "nichts offen". */
  fromDays: number | null;
  toDays: number | null;
  label: string;
  devices: number;
}

/**
 * Eigene Klasse statt eines anonymen Objekttyps inline. Das Swagger-Plugin
 * kann ein Typliteral nicht aufloesen, laesst dann `type` weg — und Swagger
 * bricht beim Erzeugen des Dokuments mit "circular dependency" ab, wodurch das
 * Backend ueberhaupt nicht startet. Genau das hat `pnpm check:openapi` hier
 * gemeldet.
 */
export class OsBuildCountDto {
  osName: string | null;
  osBuild: string | null;
  devices: number;
}

export class PatchAgeReportDto {
  buckets: PatchAgeBucketDto[];
  osBuilds: OsBuildCountDto[];
}

export class ComplianceDeviceDto {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  openSecurityUpdates: number;
  oldestOpenDays: number | null;
  lastSeenAt: string | null;
  pendingReboot: boolean;
}

export class StaleAgentDto {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  lastSeenAt: string | null;
  daysSilent: number | null;
  agentVersion: string | null;
}

export class MissingAgentDto {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  osName: string | null;
  adDn: string | null;
}

export class TimeToPatchDto {
  severity: string;
  updates: number;
  medianDays: number | null;
  p90Days: number | null;
}

export class FailureGroupDto {
  updateId: string;
  kbArticle: string | null;
  title: string;
  hresult: number | null;
  devices: number;
  attempts: number;
}

export class TrendPointDto {
  date: string;
  openUpdates: number;
  appeared: number;
  installed: number;
}

export class TrendQueryDto {
  @toInt()
  @IsInt()
  @Min(7)
  @Max(365)
  @IsOptional()
  days: number = 90;
}
