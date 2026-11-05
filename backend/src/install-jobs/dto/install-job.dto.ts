import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { UpdateClassification } from '../../common/update-classification.js';
import { InstallJobScope, InstallJobState } from '../../database/enums.js';

/** Obergrenze fuer die Streuung der Startzeiten. Vier Stunden, mehr ist ein anderer Tag. */
export const MAX_SPREAD_MINUTES = 240;

/** Vorgabe der Streuung, wenn beim Anlegen nichts angegeben ist. */
export const DEFAULT_SPREAD_MINUTES = 15;

// --- Oberflaeche ----------------------------------------------------------------

export class CreateInstallJobsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  deviceIds: string[];

  @IsEnum(InstallJobScope)
  scope: InstallJobScope;

  /** Katalog-IDs; nur und dann zwingend bei `scope = selected`. */
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(2000)
  @IsOptional()
  updateIds?: string[];

  /** Update-Typen; nur und dann zwingend bei `scope = types`. */
  @IsArray()
  @IsEnum(UpdateClassification, { each: true })
  @ArrayMaxSize(20)
  @IsOptional()
  classifications?: UpdateClassification[];

  /** Ab wann ausliefern. Ohne Angabe sofort. */
  @IsISO8601()
  @IsOptional()
  notBefore?: string;

  /**
   * Zufaellige Verzoegerung je Geraet, in Minuten — nur bei mehreren
   * Geraeten. Ohne Angabe 15.
   */
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  @Max(MAX_SPREAD_MINUTES)
  @IsOptional()
  spreadMinutes?: number;
}

export class InstallPreviewRequestDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  deviceIds: string[];
}

/** Offene Updates eines Typs auf den gewaehlten Geraeten. */
export class InstallPreviewTypeDto {
  classification: UpdateClassification;

  /** Verschiedene Updates dieses Typs. */
  updates: number;

  /** Geraete, auf denen mindestens eines davon offen ist. */
  devices: number;
}

export class InstallPreviewDto {
  /** Alle Typen in fester Reihenfolge, auch die ohne offenes Update. */
  classifications: InstallPreviewTypeDto[];
}

/** Warum Geraete keinen Auftrag bekommen haben, je Grund die Anzahl. */
export class InstallJobsSkippedDto {
  /** Es laeuft schon ein Auftrag. */
  openJob: number;

  /** Der Agent ist aelter als die Version, die Installationen ausfuehrt. */
  agentTooOld: number;

  /** Archiviert, ohne Agent oder unbekannt. */
  notEligible: number;

  /** Nichts offen, das zum Umfang passt. */
  nothingOpen: number;
}

export class CreateInstallJobsResultDto {
  /** Die angelegte Installation; null, wenn kein Geraet einen Auftrag bekam. */
  installationId: string | null;

  created: number;
  skipped: InstallJobsSkippedDto;

  /** Die Frist, mit der die Auftraege angelegt wurden. */
  expiryDays: number;

  /** Mindestversion des Agents. */
  minimumAgentVersion: string;
}

/** Ergebnis eines Updates aus einem Auftrag, mit Titel aus dem Katalog. */
export class InstallJobUpdateResultDto {
  /** WU-Update-ID. */
  updateId: string;
  kbArticle: string | null;
  title: string | null;

  /** `false`: Die Suche auf dem Geraet fand das Update nicht (mehr). */
  offered: boolean;

  resultCode: number | null;
  hresult: number | null;
  rebootRequired: boolean;
}

export class InstallJobViewDto {
  id: string;

  /** Die Installation, mit der der Auftrag angelegt wurde. */
  installationId: string;

  deviceId: string;
  hostname: string;
  scope: InstallJobScope;

  /** Anzahl der gewaehlten Updates bei `scope = selected`, sonst 0. */
  selectedCount: number;

  /** Die gewaehlten Typen bei `scope = types`, sonst leer. */
  classifications: UpdateClassification[];

  state: InstallJobState;
  notBefore: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  deliveredAt: string | null;
  startedAt: string | null;
  completedAt: string | null;

  /** Fehlermeldung bei `failed`, Hinweis bei `done` ohne Installation. */
  error: string | null;

  /** Erst nach der Rueckmeldung des Agents gesetzt. */
  results: InstallJobUpdateResultDto[] | null;
}

// --- Installationen ---------------------------------------------------------------

export class InstallationQueryDto {
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 25;
}

/** Auftraege einer Installation je Zustand. */
export class InstallationStatesDto {
  pending: number;
  delivered: number;
  running: number;
  done: number;
  failed: number;
  expired: number;
  cancelled: number;
}

/** Was in einem Zug angelegt wurde: ein Auftrag je Geraet, gemeinsamer Umfang. */
export class InstallationViewDto {
  id: string;
  scope: InstallJobScope;
  /** Anzahl der gewaehlten Updates bei `scope = selected`, sonst 0. */
  selectedCount: number;
  classifications: UpdateClassification[];
  /** Der angeforderte Start; die Geraete beginnen gestreut danach. */
  notBefore: string;
  spreadMinutes: number;
  /** So viele Geraete waren gewaehlt. */
  requestedDevices: number;
  /** Warum gewaehlte Geraete keinen Auftrag bekamen; null bei nachgetragenen. */
  skipped: InstallJobsSkippedDto | null;
  createdBy: string;
  createdAt: string;
  /** Geraete mit Auftrag. */
  devices: number;
  states: InstallationStatesDto;
  /** Erfolgreich installierte Updates, ueber alle Geraete gezaehlt. */
  installedUpdates: number;
  /** Angebotene, aber nicht installierte Updates, ueber alle Geraete gezaehlt. */
  failedUpdates: number;
  /** Geraete, die nach der Installation einen Neustart brauchen. */
  rebootDevices: number;
  /** Der juengste Abschluss eines Auftrags, null solange keiner fertig ist. */
  lastCompletedAt: string | null;
}

export class InstallationListDto {
  items: InstallationViewDto[];
  total: number;
  page: number;
  limit: number;
}

export class InstallationCancelResultDto {
  /** Abgebrochene Auftraege — nur die, die noch nicht liefen. */
  cancelled: number;
}

// --- Agent ----------------------------------------------------------------------

/** Was der Agent mit der Check-in-Antwort bekommt. */
export class InstallRequestDto {
  jobId: string;

  /** WU-Update-IDs, gegen die zuletzt gemeldete Verfuegbar-Liste aufgeloest. */
  updateIds: string[];
}

export class InstallUpdateResultDto {
  @IsString()
  @MaxLength(128)
  updateId: string;

  @IsBoolean()
  offered: boolean;

  @IsInt()
  @IsOptional()
  resultCode?: number;

  @IsInt()
  @IsOptional()
  hresult?: number;

  @IsBoolean()
  @IsOptional()
  rebootRequired?: boolean;
}

export class InstallResultDto {
  @IsUUID()
  jobId: string;

  /** `running` beim Start, am Ende `done` oder `failed`. */
  @IsIn(['running', 'done', 'failed'])
  state: 'running' | 'done' | 'failed';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InstallUpdateResultDto)
  @ArrayMaxSize(2000)
  @IsOptional()
  results?: InstallUpdateResultDto[];

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  error?: string;
}
