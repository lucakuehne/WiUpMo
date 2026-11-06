import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RestartJobState } from '../../database/enums.js';

// --- Oberflaeche ----------------------------------------------------------------

export class CreateRestartJobsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  deviceIds: string[];

  /** Erscheint in der Meldung beim Benutzer, etwa „Updates abschliessen". */
  @IsString()
  @MaxLength(200)
  @IsOptional()
  reason?: string;
}

/** Warum gewaehlte Geraete keinen Auftrag bekommen haben, je Grund die Anzahl. */
export class RestartJobsSkippedDto {
  /** Es ist schon ein Neustart offen. */
  openJob: number;
  /** Der Agent ist aelter als die Version, die Neustarts ausfuehrt. */
  agentTooOld: number;
  /** Server werden nicht neu gestartet. */
  server: number;
  /** Archiviert, ohne Agent oder unbekannt. */
  notEligible: number;
}

export class CreateRestartJobsResultDto {
  /** Die angelegte Anfrage; null, wenn kein Geraet einen Auftrag bekam. */
  requestId: string | null;
  created: number;
  skipped: RestartJobsSkippedDto;
  minimumAgentVersion: string;
}

export class RestartRequestQueryDto {
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

/** Was mit einer Anfrage beim Benutzer gilt — die Einstellungen beim Anlegen. */
export class RestartRulesDto {
  deferralMinutes: number[];
  nextMorningHour: number | null;
  maxDeferrals: number;
  deadlineHours: number;
  countdownMinutes: number;
  promptText: string;
}

export class RestartRequestViewDto {
  id: string;
  reason: string | null;
  rules: RestartRulesDto;
  requestedDevices: number;
  skipped: RestartJobsSkippedDto | null;
  createdBy: string;
  createdAt: string;
  devices: number;
  states: Record<RestartJobState, number>;
  /** Verschiebungen ueber alle Geraete. */
  deferrals: number;
  lastCompletedAt: string | null;
}

export class RestartRequestListDto {
  items: RestartRequestViewDto[];
  total: number;
  page: number;
  limit: number;
}

/** Eine Rueckmeldung des Agents, wie sie im Verlauf eines Auftrags steht. */
export class RestartEventDto {
  at: string;
  state: string;
  user?: string;
  until?: string;
  note?: string;
}

export class RestartJobViewDto {
  id: string;
  requestId: string;
  reason: string | null;
  deviceId: string;
  hostname: string;
  state: RestartJobState;
  createdAt: string;
  deliveredAt: string | null;
  /** Die erste Meldung beim Benutzer. */
  notifiedAt: string | null;
  /** Spaetestens dann wird neu gestartet, gerechnet ab der ersten Meldung. */
  deadlineAt: string | null;
  deferrals: number;
  deferredUntil: string | null;
  lastUser: string | null;
  completedAt: string | null;
  error: string | null;
  events: RestartEventDto[];
}

// --- Agent ----------------------------------------------------------------------

/** Was der Agent mit der Check-in-Antwort bekommt. */
export class RestartRequestDto {
  jobId: string;
  reason: string | null;
  deferralMinutes: number[];
  nextMorningHour: number | null;
  maxDeferrals: number;
  deadlineHours: number;
  countdownMinutes: number;

  /** Ab 0.9.1: der Text der Meldung mit Platzhaltern, die der Agent ersetzt. */
  promptText: string;

  /**
   * Bis 0.9.0 ein Zusatz unter dem Grund. Seit dem Text der Meldung bleibt er
   * leer; aeltere Agents zeigen dann nur noch den Grund.
   */
  message: string | null;
}

export class RestartResultDto {
  @IsUUID()
  jobId: string;

  /**
   * `notified`: dem Benutzer gezeigt, `deferred`: verschoben, `restarting`:
   * eingeleitet, `failed`: ging nicht (etwa auf einem Server).
   */
  @IsIn(['notified', 'deferred', 'restarting', 'failed'])
  state: 'notified' | 'deferred' | 'restarting' | 'failed';

  /** Wann es auf dem Geraet geschah; ohne Angabe der Empfang. */
  @IsISO8601()
  @IsOptional()
  at?: string;

  @IsISO8601()
  @IsOptional()
  deadlineAt?: string;

  @IsISO8601()
  @IsOptional()
  deferredUntil?: string;

  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  deferrals?: number;

  /** Der angemeldete Benutzer, der die Meldung sah oder verschob. */
  @IsString()
  @MaxLength(256)
  @IsOptional()
  user?: string;

  /** Kurzer Zusatz fuer den Verlauf, etwa „niemand angemeldet". */
  @IsString()
  @MaxLength(256)
  @IsOptional()
  note?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  error?: string;
}
