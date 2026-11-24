import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

/** Zeitraeume, ueber die die Stoerungen zusammengefasst werden, in Tagen. */
export const AGENT_PROBLEM_DAYS = [1, 7] as const;

/**
 * Dasselbe in Stunden, dazu die letzte Stunde: Ob eine Stoerung gerade
 * anhaelt oder schon vorbei ist, zeigt erst ein kurzer Zeitraum.
 */
export const AGENT_PROBLEM_HOURS = [1, 24, 168] as const;

export class AgentProblemQueryDto {
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsIn(AGENT_PROBLEM_DAYS)
  @IsOptional()
  days: number = 1;

  /** Geht `days` vor, wenn beides kommt. */
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsIn(AGENT_PROBLEM_HOURS)
  @IsOptional()
  hours?: number;
}

/** Ein Geraet mit einer Stoerung: die juengste Meldung und wie oft sie kam. */
export class AgentProblemDeviceDto {
  deviceId: string;
  hostname: string;
  lastAt: string;
  occurrences: number;
  message: string;
}

/** Gleichartige Meldungen ueber alle Geraete. */
export class AgentProblemDto {
  /** Die Meldung mit ersetzten Zahlen — woran sie zusammengefasst wurde. */
  key: string;
  /** Die juengste Meldung im Wortlaut. */
  message: string;
  /** `error`, sobald eine der Meldungen ein Fehler war, sonst `warning`. */
  level: 'error' | 'warning';
  devices: number;
  occurrences: number;
  lastAt: string;

  /**
   * Entstand, waehrend die Geraete offline waren — die Update-Suche scheiterte,
   * und im selben Durchlauf auch die Uebermittlung ans Backend. Keine Stoerung;
   * diese Gruppen stehen getrennt und zuletzt.
   */
  offline: boolean;

  /** Die betroffenen Geraete, juengste Meldung zuerst. */
  entries: AgentProblemDeviceDto[];
}
