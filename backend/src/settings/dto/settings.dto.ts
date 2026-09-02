import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

export class AdSettingsDto {
  /**
   * Nur `ldap://` und `ldaps://`. Ein Tippfehler im Schema fuehrt sonst zu
   * einem Verbindungsfehler, dessen Ursache man dem Text nicht ansieht.
   */
  @IsString()
  @MaxLength(512)
  @Matches(/^$|^ldaps?:\/\/\S+$/, {
    message: 'Die Adresse muss mit ldap:// oder ldaps:// beginnen.',
  })
  @IsOptional()
  url?: string;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  baseDn?: string;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  bindDn?: string;

  /** Leer lassen heisst "unveraendert". */
  @IsString()
  @MaxLength(512)
  @IsOptional()
  bindPassword?: string;

  @IsString()
  @MaxLength(512)
  @IsOptional()
  filter?: string;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  pageSize?: number;

  /**
   * Untergrenze von 5 Minuten: Ein Abgleich liest die gesamte Domaene und
   * belastet den Domaenencontroller. Wer ihn im Minutentakt laufen liesse,
   * faende den Fehler erst im DC-Protokoll.
   */
  @toInt()
  @IsInt()
  @Min(5)
  @Max(10080)
  @IsOptional()
  intervalMinutes?: number;

  @toInt()
  @IsInt()
  @Min(0)
  @Max(3600)
  @IsOptional()
  startupDelaySeconds?: number;

  @IsBoolean()
  @IsOptional()
  tlsRejectUnauthorized?: boolean;

  @toInt()
  @IsInt()
  @Min(5)
  @Max(600)
  @IsOptional()
  timeoutSeconds?: number;
}

export class ThresholdSettingsDto {
  @toInt()
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  staleAgentDays?: number;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  criticalOpenDays?: number;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  pendingRebootDays?: number;
}

export class RetentionSettingsDto {
  /**
   * Untergrenze von 7 Tagen. Der Aufbewahrungsjob loescht endgueltig; ein
   * versehentlicher Wert von 1 waere nicht rueckgaengig zu machen.
   */
  @toInt()
  @IsInt()
  @Min(7)
  @Max(3650)
  @IsOptional()
  eventDays?: number;

  @toInt()
  @IsInt()
  @Min(7)
  @Max(3650)
  @IsOptional()
  checkinDays?: number;
}

/** Ansicht der AD-Einstellungen ohne das Passwort. */
export class AdSettingsViewDto {
  url: string;
  baseDn: string;
  bindDn: string;
  bindPasswordSet: boolean;
  filter: string;
  pageSize: number;
  intervalMinutes: number;
  startupDelaySeconds: number;
  tlsRejectUnauthorized: boolean;
  timeoutSeconds: number;

  /** Abgeleitet: gesetzt, sobald Adresse und Suchwurzel gefuellt sind. */
  configured: boolean;
}

export class ThresholdSettingsViewDto {
  staleAgentDays: number;
  criticalOpenDays: number;
  pendingRebootDays: number;
}

export class RetentionSettingsViewDto {
  eventDays: number;
  checkinDays: number;
}

export class SettingsViewDto {
  ad: AdSettingsViewDto;
  thresholds: ThresholdSettingsViewDto;
  retention: RetentionSettingsViewDto;
}
