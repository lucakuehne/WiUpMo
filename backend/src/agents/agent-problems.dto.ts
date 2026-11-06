import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

/** Zeitraeume, ueber die die Stoerungen zusammengefasst werden, in Tagen. */
export const AGENT_PROBLEM_DAYS = [1, 7] as const;

export class AgentProblemQueryDto {
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsIn(AGENT_PROBLEM_DAYS)
  @IsOptional()
  days: number = 1;
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
  /** Die betroffenen Geraete, juengste Meldung zuerst. */
  entries: AgentProblemDeviceDto[];
}
