import { IsString, MaxLength, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MaxLength(128)
  username: string;

  @IsString()
  @MaxLength(256)
  password: string;
}

export class SetupDto {
  /**
   * Keine Leerzeichen und keine Sonderzeichen: der Benutzername soll spaeter
   * unveraendert als LDAP-Kennung taugen, wenn Phase 7 den zweiten
   * Auth-Provider ergaenzt.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'Der Benutzername darf nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich enthalten.',
  })
  username: string;

  /**
   * Zwoelf Zeichen, weil dieses Konto die gesamte Auswertung der Geraeteflotte
   * oeffnet und die Einrichtungsseite von jedem erreichbar ist, der das
   * Frontend als Erster aufruft.
   */
  @IsString()
  @MinLength(12, { message: 'Das Passwort muss mindestens 12 Zeichen lang sein.' })
  @MaxLength(256)
  password: string;
}

export class AuthStatusDto {
  /** `true`, solange kein Benutzer existiert — dann zeigt das Frontend die Einrichtung. */
  setupRequired: boolean;

  authenticated: boolean;

  username: string | null;

  /** `local` oder spaeter `ldap`. */
  provider: string;
}

export class SessionUserDto {
  id: string;
  username: string;
}
