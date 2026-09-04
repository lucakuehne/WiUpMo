import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AgentUpdateJobState } from '../../database/enums.js';

export class UploadReleaseDto {
  /**
   * Semantische Version ohne Praefix, z. B. `0.2.0`. Sie wird zum
   * Verzeichnisnamen — deshalb das strenge Muster: ein Wert wie `../etc`
   * duerfte hier niemals durchkommen.
   */
  @IsString()
  @Matches(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    message: 'Die Version muss der Form 1.2.3 bzw. 1.2.3-vorab entsprechen.',
  })
  @MaxLength(32)
  version: string;

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
  deviceId: string;
  hostname: string;
  targetVersion: string;
  state: AgentUpdateJobState;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export class CreateUpdateJobsResultDto {
  @ApiProperty({ description: 'Angelegte Auftraege.' })
  created: number;

  @ApiProperty({ description: 'Uebersprungen, weil bereits ein Auftrag offen war.' })
  skipped: number;

  targetVersion: string;
}
