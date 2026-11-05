import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { UpdateClassification } from '../../common/update-classification.js';
import { UpdateState } from '../../database/enums.js';

const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

const toBool = () =>
  Transform(({ value }) =>
    value === undefined || value === '' ? undefined : ['1', 'true', 'yes'].includes(String(value).toLowerCase()),
  );

export const UPDATE_SORT_FIELDS = [
  'affectedDevices',
  'installedDevices',
  'failedDevices',
  'title',
  'kbArticle',
  'firstSeenAt',
  'severity',
  'classification',
  'sizeBytes',
] as const;

export type UpdateSortField = (typeof UPDATE_SORT_FIELDS)[number];

/** Einstufung durch Microsoft, kleingeschrieben; `none` fuer Updates ohne. */
export const UPDATE_SEVERITY_FILTERS = ['critical', 'important', 'moderate', 'low', 'none'] as const;

export type UpdateSeverityFilter = (typeof UPDATE_SEVERITY_FILTERS)[number];

/**
 * Zustand ueber alle aktiven Geraete: offen auf mindestens einem, gescheitert
 * auf mindestens einem, oder auf keinem mehr offen.
 */
export const UPDATE_STATE_FILTERS = ['open', 'failed', 'closed'] as const;

export type UpdateStateFilter = (typeof UPDATE_STATE_FILTERS)[number];

/** Die Filter ohne Seite und Sortierung — gemeinsam fuer Liste, Typen und Export. */
export class UpdateFilterDto {
  /** Freitext auf Titel und KB-Nummer. */
  @IsString()
  @MaxLength(128)
  @IsOptional()
  search?: string;

  @toBool()
  @IsBoolean()
  @IsOptional()
  isSecurity?: boolean;

  /** Update-Typ, wie ihn auch die Installationsauftraege verwenden. */
  @IsEnum(UpdateClassification)
  @IsOptional()
  classification?: UpdateClassification;

  @IsIn(UPDATE_SEVERITY_FILTERS)
  @IsOptional()
  severity?: UpdateSeverityFilter;

  @IsIn(UPDATE_STATE_FILTERS)
  @IsOptional()
  state?: UpdateStateFilter;
}

export class UpdateQueryDto extends UpdateFilterDto {
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

  @IsIn(UPDATE_SORT_FIELDS)
  @IsOptional()
  sortBy: UpdateSortField = 'affectedDevices';

  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortDir: 'asc' | 'desc' = 'desc';
}

export class UpdateListItemDto {
  id: string;
  wuUpdateId: string;
  kbArticle: string | null;
  title: string;
  severity: string | null;
  categories: string[];
  classification: UpdateClassification;
  isSecurity: boolean;
  msrcNumber: string | null;
  sizeBytes: string | null;
  supportUrl: string | null;
  firstSeenAt: string | null;

  /** Geraete, auf denen das Update offen ist. */
  affectedDevices: number;

  installedDevices: number;
  failedDevices: number;
}

/** Anzahl der Updates eines Typs unter den uebrigen Filtern. */
export class UpdateClassificationCountDto {
  classification: UpdateClassification;
  updates: number;
}

export class UpdateListDto {
  items: UpdateListItemDto[];
  total: number;
  page: number;
  limit: number;
}

export class UpdateDeviceDto {
  deviceId: string;
  hostname: string;
  adOu: string | null;
  state: UpdateState;
  firstAvailableAt: string | null;
  installedAt: string | null;
  hresult: number | null;
  /** Eingespielt, wartet aber auf den Neustart (0x80242014). */
  awaitingReboot: boolean;
  lastSeenAt: string | null;
}

export class UpdateDevicesDto {
  /** Geraete mit einem Zustand zu diesem Update. */
  items: UpdateDeviceDto[];

  /**
   * Registrierte Geraete ohne jeden Zustand zu diesem Update — sie haben es nie
   * angeboten bekommen. Das ist die interessantere Haelfte der Frage "wer hat
   * das KB nicht": nicht betroffen ist etwas anderes als noch nicht installiert.
   */
  unaffected: number;
}
