import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { UpdateState } from '../../database/enums.js';

const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

const toBool = () =>
  Transform(({ value }) =>
    value === undefined || value === '' ? undefined : ['1', 'true', 'yes'].includes(String(value).toLowerCase()),
  );

export const UPDATE_SORT_FIELDS = [
  'affectedDevices',
  'title',
  'kbArticle',
  'firstSeenAt',
  'severity',
] as const;

export type UpdateSortField = (typeof UPDATE_SORT_FIELDS)[number];

export class UpdateQueryDto {
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

  /** Freitext auf Titel und KB-Nummer. */
  @IsString()
  @MaxLength(128)
  @IsOptional()
  search?: string;

  @toBool()
  @IsBoolean()
  @IsOptional()
  isSecurity?: boolean;

  /** Nur Updates, die auf mindestens einem Geraet offen sind. */
  @toBool()
  @IsBoolean()
  @IsOptional()
  onlyOpen?: boolean;
}

export class UpdateListItemDto {
  id: string;
  wuUpdateId: string;
  kbArticle: string | null;
  title: string;
  severity: string | null;
  categories: string[];
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
