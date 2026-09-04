import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AdSettingsDto } from '../../settings/dto/settings.dto.js';

/**
 * Sondierung mit noch nicht gespeicherten Werten.
 *
 * Erbt die Felder der Einstellungen, damit sich eine Eingabe pruefen laesst,
 * bevor sie gespeichert wird — sonst muesste man eine womoeglich falsche
 * Konfiguration erst scharf schalten, um zu erfahren, ob sie stimmt.
 *
 * Bleibt das Passwortfeld leer, wird das gespeicherte verwendet. Es wird nie
 * ausgeliefert, koennte also gar nicht mitgeschickt werden.
 */
export class AdProbeRequestDto extends AdSettingsDto {}

export class AdProbeResultDto {
  ok: boolean;

  /** Verstaendliche Meldung, im Erfolgs- wie im Fehlerfall. */
  message: string;

  dnsHostName: string | null;
  defaultNamingContext: string | null;
  namingContexts: string[];
  domainDnsName: string | null;
  domainNetbiosName: string | null;

  /** Treffer des eingestellten Filters unterhalb der Suchwurzel. `null`, wenn keine gesetzt ist. */
  matchedComputers: number | null;

  /** Der tatsaechlich verwendete Ausdruck — auch im gefuehrten Modus sichtbar. */
  effectiveFilter: string;
}

export class OrganizationalUnitDto {
  dn: string;
  name: string;
  depth: number;
}

export class ListOusRequestDto extends AdSettingsDto {
  /** Ohne Angabe wird die Domaenenwurzel aus der Sondierung genommen. */
  @IsString()
  @MaxLength(512)
  @IsOptional()
  base?: string;
}
