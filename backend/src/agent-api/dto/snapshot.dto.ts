import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { UpdateSource } from '../../database/enums.js';

/**
 * Ergebniscode der Windows-Update-API (`OperationResultCode`).
 * Wird als Zahl uebertragen, weil der Agent ihn genauso von COM erhaelt.
 */
export enum OperationResultCode {
  NotStarted = 0,
  InProgress = 1,
  Succeeded = 2,
  SucceededWithErrors = 3,
  Failed = 4,
  Aborted = 5,
}

export enum HistoryOperation {
  Installation = 'installation',
  Uninstallation = 'uninstallation',
  Other = 'other',
}

export class HostInfoDto {
  @IsString()
  @MaxLength(255)
  hostname: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  osName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  osVersion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  osBuild?: string;

  /** `objectGUID` des Computerkontos, sofern das Geraet in einer Domaene ist. */
  @IsUUID()
  @IsOptional()
  adObjectGuid?: string;
}

export class UpdateSourceInfoDto {
  @IsEnum(UpdateSource)
  source: UpdateSource;

  @IsString()
  @IsOptional()
  @MaxLength(1024)
  wsusServerUrl?: string;

  /** Registry `UseWUServer` unter Policies\Microsoft\Windows\WindowsUpdate\AU. */
  @IsBoolean()
  @IsOptional()
  useWuServer?: boolean;

  /** Anzeigenamen der bei `IUpdateServiceManager2` registrierten Dienste. */
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  @IsOptional()
  registeredServices?: string[];

  @IsBoolean()
  @IsOptional()
  mdmEnrolled?: boolean;
}

export class AvailableUpdateDto {
  /** `IUpdateIdentity.UpdateID`. */
  @IsString()
  @MaxLength(128)
  updateId: string;

  @IsInt()
  @IsOptional()
  revisionNumber?: number;

  /** Ohne fuehrendes "KB". */
  @IsString()
  @IsOptional()
  @MaxLength(32)
  kbArticle?: string;

  @IsString()
  @MaxLength(1024)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  severity?: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(32)
  @IsOptional()
  categories?: string[];

  @IsBoolean()
  @IsOptional()
  isSecurity?: boolean;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  msrcNumber?: string;

  /**
   * Als Zeichenkette, nicht als Zahl: `MaxDownloadSize` kann groesser werden
   * als `Number.MAX_SAFE_INTEGER` sinnvoll traegt, und die Spalte ist bigint.
   */
  @IsString()
  @IsOptional()
  @MaxLength(32)
  sizeBytes?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  supportUrl?: string;

  @IsBoolean()
  @IsOptional()
  rebootRequired?: boolean;
}

export class HistoryEntryDto {
  @IsString()
  @IsOptional()
  @MaxLength(128)
  updateId?: string;

  @IsInt()
  @IsOptional()
  revisionNumber?: number;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  kbArticle?: string;

  @IsString()
  @MaxLength(1024)
  title: string;

  @IsEnum(HistoryOperation)
  operation: HistoryOperation;

  @IsInt()
  @Min(0)
  @Max(5)
  resultCode: OperationResultCode;

  /** Vorzeichenbehafteter 32-Bit-Wert; 0 bei Erfolg. */
  @IsInt()
  hresult: number;

  /** Zeitpunkt auf dem Geraet, in UTC. */
  @IsISO8601()
  occurredAt: string;

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  supportUrl?: string;
}

export class SnapshotDto {
  /**
   * Vom Agent erzeugt. Traegt die Idempotenz: derselbe Snapshot darf beliebig
   * oft ankommen und wird genau einmal verarbeitet.
   */
  @IsUUID()
  snapshotId: string;

  /** Erfassungszeitpunkt auf dem Geraet, UTC. Nicht der Empfangszeitpunkt. */
  @IsISO8601()
  collectedAt: string;

  @IsString()
  @MaxLength(32)
  agentVersion: string;

  @ValidateNested()
  @Type(() => HostInfoDto)
  host: HostInfoDto;

  @ValidateNested()
  @Type(() => UpdateSourceInfoDto)
  updateSource: UpdateSourceInfoDto;

  @IsBoolean()
  pendingReboot: boolean;

  /**
   * Vollstaendige Liste der offenen Updates. Bewusst vollstaendig und nicht
   * als Differenz: nur so laesst sich erkennen, dass ein Update verschwunden
   * ist, ohne installiert worden zu sein.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailableUpdateDto)
  @ArrayMaxSize(2000)
  availableUpdates: AvailableUpdateDto[];

  /** Installationshistorie seit dem letzten erfolgreichen Check-in. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HistoryEntryDto)
  @ArrayMaxSize(2000)
  history: HistoryEntryDto[];
}
