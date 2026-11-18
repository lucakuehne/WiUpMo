import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Hardware-Angaben des Agents (ab 0.10.0). Alles optional: Was sich auf dem
 * Geraet nicht lesen liess, fehlt — etwa das TPM auf einer virtuellen Maschine.
 *
 * Jedes Feld ist hier ausdruecklich aufgefuehrt: Die ValidationPipe steht auf
 * `forbidNonWhitelisted`, ein unbekanntes Feld liesse den ganzen Snapshot
 * durchfallen. Neue Angaben brauchen deshalb zuerst ein Backend, das sie kennt.
 */

const CHASSIS = ['notebook', 'desktop', 'tablet', 'server', 'virtual', 'other'] as const;
const FIRMWARE = ['uefi', 'bios'] as const;
const MEDIA = ['ssd', 'hdd', 'scm', 'unknown'] as const;
const BITLOCKER = ['on', 'off', 'suspended', 'encrypting', 'decrypting'] as const;
const ADAPTER_KIND = ['wifi', 'ethernet', 'bluetooth', 'mobile', 'other'] as const;

export class HardwareProcessorDto {
  @IsString() @MaxLength(256) @IsOptional() name?: string;
  @IsInt() @Min(0) @IsOptional() cores?: number;
  @IsInt() @Min(0) @IsOptional() logicalProcessors?: number;
  @IsInt() @Min(0) @IsOptional() maxClockMhz?: number;
  @IsInt() @Min(0) @IsOptional() count?: number;
}

export class HardwareMemoryModuleDto {
  /** Steckplatz laut SMBIOS, etwa `DIMM 0`. */
  @IsString() @MaxLength(64) @IsOptional() slot?: string;
  /** Speichertyp, etwa `DDR4` oder `LPDDR5`. */
  @IsString() @MaxLength(16) @IsOptional() type?: string;
  @IsInt() @Min(0) @IsOptional() capacityBytes?: number;
  @IsInt() @Min(0) @IsOptional() speedMhz?: number;
  @IsString() @MaxLength(64) @IsOptional() manufacturer?: string;
  @IsString() @MaxLength(64) @IsOptional() partNumber?: string;
}

export class HardwareDiskDto {
  @IsString() @MaxLength(256) @IsOptional() model?: string;
  @IsInt() @Min(0) @IsOptional() sizeBytes?: number;
  @IsIn(MEDIA) @IsOptional() mediaType?: (typeof MEDIA)[number];
  @IsString() @MaxLength(32) @IsOptional() busType?: string;
}

export class HardwareVolumeDto {
  @IsString() @MaxLength(8) @IsOptional() drive?: string;
  @IsString() @MaxLength(256) @IsOptional() label?: string;
  @IsString() @MaxLength(32) @IsOptional() fileSystem?: string;
  @IsInt() @Min(0) @IsOptional() sizeBytes?: number;
  @IsInt() @Min(0) @IsOptional() freeBytes?: number;
  @IsIn(BITLOCKER) @IsOptional() bitLocker?: (typeof BITLOCKER)[number];
}

export class HardwareTpmDto {
  @IsBoolean() @IsOptional() present?: boolean;
  @IsString() @MaxLength(16) @IsOptional() version?: string;
  @IsBoolean() @IsOptional() enabled?: boolean;
  @IsBoolean() @IsOptional() activated?: boolean;
  @IsString() @MaxLength(64) @IsOptional() manufacturer?: string;
}

export class HardwareGraphicsDto {
  @IsString() @MaxLength(256) @IsOptional() name?: string;
  @IsString() @MaxLength(64) @IsOptional() driverVersion?: string;
}

export class HardwareNetworkAdapterDto {
  @IsString() @MaxLength(256) @IsOptional() name?: string;
  @IsString() @MaxLength(256) @IsOptional() connection?: string;
  @IsString() @MaxLength(32) @IsOptional() macAddress?: string;
  @IsIn(ADAPTER_KIND) @IsOptional() kind?: (typeof ADAPTER_KIND)[number];
  @IsBoolean() @IsOptional() connected?: boolean;
  @IsInt() @Min(0) @IsOptional() speedBitsPerSecond?: number;
}

export class HardwareMonitorDto {
  @IsString() @MaxLength(64) @IsOptional() manufacturer?: string;
  @IsString() @MaxLength(256) @IsOptional() name?: string;
  @IsString() @MaxLength(64) @IsOptional() serialNumber?: string;
  @IsInt() @Min(0) @IsOptional() year?: number;
  @IsBoolean() @IsOptional() internal?: boolean;
}

export class HardwareBatteryDto {
  @IsString() @MaxLength(256) @IsOptional() name?: string;
  @IsString() @MaxLength(64) @IsOptional() manufacturer?: string;
  @IsInt() @Min(0) @IsOptional() designCapacityMwh?: number;
  @IsInt() @Min(0) @IsOptional() fullChargeCapacityMwh?: number;
  @IsInt() @Min(0) @IsOptional() cycleCount?: number;
}

export class HardwareInfoDto {
  @IsString() @MaxLength(256) @IsOptional() manufacturer?: string;

  /** Modellbezeichnung laut Hersteller, bei Lenovo die Maschinentyp-Nummer. */
  @IsString() @MaxLength(256) @IsOptional() model?: string;

  /** Produktfamilie, bei Lenovo der lesbare Name. */
  @IsString() @MaxLength(256) @IsOptional() family?: string;

  @IsString() @MaxLength(256) @IsOptional() sku?: string;
  @IsString() @MaxLength(64) @IsOptional() serialNumber?: string;
  @IsIn(CHASSIS) @IsOptional() chassis?: (typeof CHASSIS)[number];
  @IsIn(FIRMWARE) @IsOptional() firmware?: (typeof FIRMWARE)[number];
  @IsString() @MaxLength(64) @IsOptional() biosVendor?: string;
  @IsString() @MaxLength(64) @IsOptional() biosVersion?: string;
  @IsISO8601() @IsOptional() biosDate?: string;

  @ValidateNested() @Type(() => HardwareProcessorDto) @IsOptional() processor?: HardwareProcessorDto;

  /** Eingebauter Arbeitsspeicher, Summe der Module. */
  @IsInt() @Min(0) @IsOptional() memoryBytes?: number;

  @IsArray() @ArrayMaxSize(16) @ValidateNested({ each: true }) @Type(() => HardwareMemoryModuleDto) @IsOptional()
  memoryModules?: HardwareMemoryModuleDto[];

  @IsArray() @ArrayMaxSize(16) @ValidateNested({ each: true }) @Type(() => HardwareDiskDto) @IsOptional()
  disks?: HardwareDiskDto[];

  /** Feste Laufwerke; der freie Platz ist der beim Erfassen. */
  @IsArray() @ArrayMaxSize(26) @ValidateNested({ each: true }) @Type(() => HardwareVolumeDto) @IsOptional()
  volumes?: HardwareVolumeDto[];

  @ValidateNested() @Type(() => HardwareTpmDto) @IsOptional() tpm?: HardwareTpmDto;
  @IsBoolean() @IsOptional() secureBoot?: boolean;

  @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => HardwareGraphicsDto) @IsOptional()
  graphics?: HardwareGraphicsDto[];

  @IsArray() @ArrayMaxSize(16) @ValidateNested({ each: true }) @Type(() => HardwareNetworkAdapterDto) @IsOptional()
  networkAdapters?: HardwareNetworkAdapterDto[];

  @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => HardwareMonitorDto) @IsOptional()
  monitors?: HardwareMonitorDto[];

  @ValidateNested() @Type(() => HardwareBatteryDto) @IsOptional() battery?: HardwareBatteryDto;
}
