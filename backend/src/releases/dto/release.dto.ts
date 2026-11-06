import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { AgentUpdateJobState } from '../../database/enums.js';

/**
 * Semantische Version ohne Praefix, z. B. `0.2.0`.
 *
 * Sie wird zum Verzeichnisnamen — deshalb das strenge Muster: ein Wert wie
 * `../etc` duerfte hier niemals durchkommen. Es gilt auch fuer die aus der
 * Datei gelesene Version, denn auch die stammt aus einer hochgeladenen Datei.
 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class UploadReleaseDto {
  /**
   * Wird normalerweise nicht mitgeschickt: Sie steht in der Programmdatei und
   * wird von dort gelesen. Nur fuer den Fall, dass eine Datei keine
   * Versionsangabe traegt, bleibt sie angebbar.
   */
  @IsString()
  @Matches(VERSION_PATTERN, {
    message: 'Die Version muss der Form 1.2.3 bzw. 1.2.3-vorab entsprechen.',
  })
  @MaxLength(32)
  @IsOptional()
  version?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  notes?: string;
}

export class AgentReleaseDto {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: string;
  releasedAt: string;
  isCurrent: boolean;
  notes: string | null;

  /** Geraete, die diese Version melden. */
  devices: number;
}

/**
 * Der Auftrag, den der Agent in der Check-in-Antwort erhaelt.
 *
 * Enthaelt alles, was er zum Selbst-Update braucht — Version, Pruefsumme und
 * Pfad. Die Pruefsumme kommt bewusst hier mit und wird nicht separat abgefragt:
 * Der Agent soll die heruntergeladene Datei gegen einen Wert pruefen, den er im
 * selben authentifizierten Aufruf erhalten hat.
 */
export class AgentUpdateJobDto {
  jobId: string;
  targetVersion: string;
  sha256: string;

  /** Relativ zur Backend-Basisadresse. */
  downloadPath: string;
}

export class UpdateResultDto {
  @IsUUID()
  jobId: string;

  /**
   * Nur die Endzustaende und `installing`. `pending` und `delivered` setzt das
   * Backend selbst — die duerfen nicht vom Geraet kommen.
   */
  @IsString()
  @Matches(/^(installing|done|failed)$/, {
    message: 'state muss installing, done oder failed sein.',
  })
  state: 'installing' | 'done' | 'failed';

  @IsString()
  @IsOptional()
  @MaxLength(32)
  agentVersion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  error?: string;
}

export class CreateUpdateJobsDto {
  /** Leer bedeutet: alle aktiven Geraete, deren Version abweicht. */
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  deviceIds?: string[];

  /** Ohne Angabe wird die als aktuell markierte Version verwendet. */
  @IsString()
  @IsOptional()
  @MaxLength(32)
  targetVersion?: string;
}

export class AgentUpdateJobViewDto {
  id: string;

  /** Das Ausrollen, mit dem der Auftrag angelegt wurde. */
  rolloutId: string;

  deviceId: string;
  hostname: string;
  targetVersion: string;
  state: AgentUpdateJobState;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export class CreateUpdateJobsResultDto {
  @ApiProperty({ description: 'Das angelegte Ausrollen; null, wenn kein Geraet einen Auftrag bekam.' })
  rolloutId: string | null;

  @ApiProperty({ description: 'Angelegte Auftraege.' })
  created: number;

  @ApiProperty({ description: 'Uebersprungen, weil bereits ein Auftrag offen war.' })
  skipped: number;

  targetVersion: string;
}

// --- Ausrollen --------------------------------------------------------------------

export type AgentRolloutScope = 'outdated' | 'selected' | 'unknown';

export class AgentRolloutQueryDto {
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

/**
 * Auftraege je Zustand. `cancelled` sind die von Hand abgebrochenen; sie
 * stehen in der Tabelle als `failed`, zaehlen hier aber nicht als gescheitert.
 */
export class AgentRolloutStatesDto {
  pending: number;
  delivered: number;
  installing: number;
  done: number;
  failed: number;
  cancelled: number;
}

/** Was in einem Zug beauftragt wurde: ein Auftrag je Geraet, dieselbe Zielversion. */
export class AgentRolloutViewDto {
  id: string;
  targetVersion: string;
  /** `outdated`: alle mit abweichender Version, `selected`: eine Auswahl, `unknown`: nachgetragen. */
  scope: AgentRolloutScope;
  /** Gewaehlte Geraete bei `selected`, sonst null. */
  requestedDevices: number | null;
  /** Uebergangen, weil schon ein Auftrag offen war. */
  skipped: number;
  /** Null bei nachgetragenen Ausrollen. */
  createdBy: string | null;
  createdAt: string;
  devices: number;
  states: AgentRolloutStatesDto;
  lastCompletedAt: string | null;
}

export class AgentRolloutListDto {
  items: AgentRolloutViewDto[];
  total: number;
  page: number;
  limit: number;
}
