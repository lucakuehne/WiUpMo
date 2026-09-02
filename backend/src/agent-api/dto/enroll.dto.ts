import { Type } from 'class-transformer';
import { IsString, MaxLength, ValidateNested } from 'class-validator';
import { HostInfoDto } from './snapshot.dto.js';

export class EnrollRequestDto {
  /**
   * Gemeinsames Geheimnis aus der Backend-Konfiguration. Wird nur einmalig
   * vorgelegt; danach arbeitet das Geraet mit seinem eigenen Secret.
   */
  @IsString()
  @MaxLength(512)
  enrollmentToken: string;

  @ValidateNested()
  @Type(() => HostInfoDto)
  host: HostInfoDto;

  @IsString()
  @MaxLength(32)
  agentVersion: string;
}

export class EnrollResponseDto {
  deviceId: string;

  /**
   * Wird genau einmal ausgeliefert und danach nur noch als Hash gespeichert.
   * Der Agent legt ihn per DPAPI im Maschinenkontext ab.
   */
  deviceSecret: string;

  /** Vollstaendiger Wert fuer den Authorization-Header: `Bearer <token>`. */
  token: string;
}
