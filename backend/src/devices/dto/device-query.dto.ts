import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DeviceStatus, UpdateSource } from '../../database/enums.js';

const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

const toBool = () =>
  Transform(({ value }) =>
    value === undefined || value === '' ? undefined : ['1', 'true', 'yes'].includes(String(value).toLowerCase()),
  );

/**
 * Sortierbare Spalten als feste Liste. Der Wert geht in die
 * `ORDER BY`-Klausel — er darf niemals frei aus der Anfrage stammen.
 */
export const DEVICE_SORT_FIELDS = [
  'hostname',
  'lastSeenAt',
  'osBuild',
  'openUpdates',
  'openSecurityUpdates',
  'patchAgeDays',
  'updateSource',
  'agentVersion',
] as const;

export type DeviceSortField = (typeof DEVICE_SORT_FIELDS)[number];

export class DeviceQueryDto {
  @toInt()
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit: number = 25;

  @IsIn(DEVICE_SORT_FIELDS)
  @IsOptional()
  sortBy: DeviceSortField = 'hostname';

  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortDir: 'asc' | 'desc' = 'asc';

  /** Freitext auf Hostname und OU. */
  @IsString()
  @MaxLength(128)
  @IsOptional()
  search?: string;

  @IsEnum(DeviceStatus)
  @IsOptional()
  status?: DeviceStatus;

  /**
   * Organisationseinheit als DN, einschliesslich aller darunterliegenden.
   *
   * Der Unterbaum ist die einzig brauchbare Auslegung: Wer im Baum auf
   * `OU=Clients` klickt, meint die Notebooks und Arbeitsplaetze darunter mit —
   * direkt in einer Zwischenebene liegen selten Konten.
   */
  @IsString()
  @MaxLength(512)
  @IsOptional()
  ou?: string;

  @IsEnum(UpdateSource)
  @IsOptional()
  updateSource?: UpdateSource;

  /** Nur Geraete, deren letzter Check-in laenger als N Tage zurueckliegt. */
  @toInt()
  @IsInt()
  @Min(0)
  @Max(3650)
  @IsOptional()
  staleDays?: number;

  /** `true` nur mit ausstehendem Neustart, `false` nur ohne, weggelassen: egal. */
  @toBool()
  @IsBoolean()
  @IsOptional()
  pendingReboot?: boolean;

  /** Nur Geraete mit mindestens einem offenen sicherheitsrelevanten Update. */
  @toBool()
  @IsBoolean()
  @IsOptional()
  hasOpenSecurity?: boolean;

  /**
   * `false` sind die Geraete, die sich noch nie gemeldet haben — die
   * Deployment-Luecke. `true` ist die Gegenprobe, weggelassen: egal.
   */
  @toBool()
  @IsBoolean()
  @IsOptional()
  hasAgent?: boolean;
}

export class DeviceOuQueryDto {
  @IsEnum(DeviceStatus)
  @IsOptional()
  status?: DeviceStatus;
}

/** Ein Knoten der OU-Navigation: der DN und die Zahl der Geraete darin. */
export class DeviceOuDto {
  dn: string;

  /** Nur die unmittelbar in dieser Einheit liegenden; Untereinheiten zaehlen eigene. */
  devices: number;
}

export class DeviceListItemDto {
  id: string;
  hostname: string;
  adOu: string | null;
  osName: string | null;
  osVersion: string | null;
  osBuild: string | null;
  status: DeviceStatus;
  agentVersion: string | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  updateSource: UpdateSource | null;
  pendingReboot: boolean;
  openUpdates: number;
  openSecurityUpdates: number;

  /**
   * Alter des aeltesten offenen Updates in Tagen — die eine Kennzahl, nach der
   * sich die Flotte sortieren laesst. `null`, wenn nichts offen ist.
   */
  patchAgeDays: number | null;
}

export class DeviceListDto {
  items: DeviceListItemDto[];
  total: number;
  page: number;
  limit: number;
}
