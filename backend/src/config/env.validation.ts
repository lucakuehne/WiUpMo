import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * `.env`-Werte sind immer Zeichenketten. Diese beiden Helfer wandeln sie in den
 * erwarteten Typ um, damit die Validierung unten etwas Sinnvolles pruefen kann.
 */
const toInt = () => Transform(({ obj, key, value }) => (key in obj ? Number(value) : value));

/**
 * Beide Umwandlungen lassen einen nicht uebergebenen Wert unangetastet
 * durch — dort steht dank `exposeDefaultValues` bereits der Vorgabewert der
 * Klasse. Wuerden sie stattdessen `undefined` zurueckgeben, ueberschrieben sie
 * ihn, und aus `PORT = 3000` wuerde `undefined`.
 */
const toBool = () =>
  Transform(({ obj, key, value }) => {
    if (!(key in obj)) return value;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  });

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  DB_HOST: string;

  @toInt()
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  DB_PORT: number = 5432;

  @IsString()
  DB_USER: string;

  @IsString()
  DB_PASSWORD: string;

  @IsString()
  DB_NAME: string;

  @toBool()
  @IsBoolean()
  @IsOptional()
  DB_SSL: boolean = false;

  /**
   * Nur noch die Erstbefuellung. Das Enrollment-Token liegt in den
   * Einstellungen und wird dort im Frontend abgelesen und erneuert; fehlt die
   * Variable, erzeugt das Backend beim ersten Start selbst eines.
   *
   * Gesetzt bleiben sollte sie nur bei einer bestehenden Installation, deren
   * Agents bereits mit diesem Wert verteilt wurden.
   */
  @IsString()
  @MinLength(16, {
    message: 'AGENT_ENROLLMENT_TOKEN muss mindestens 16 Zeichen lang sein.',
  })
  @IsOptional()
  AGENT_ENROLLMENT_TOKEN?: string;

  /**
   * Erlaubte Herkuenfte fuer das Frontend, kommagetrennt. Leer = keine
   * Cross-Origin-Freigabe (Frontend wird vom selben Container ausgeliefert).
   */
  @IsString()
  @IsOptional()
  CORS_ORIGINS: string = '';

  /**
   * Signaturgeheimnis der Anmeldesitzungen. Optional: fehlt es, erzeugt das
   * Backend einmalig eines und legt es in `settings` ab. Setzen lohnt sich, wer
   * mehrere Instanzen betreibt oder rotieren koennen will — dann entwertet ein
   * Wechsel gezielt alle Sitzungen.
   */
  @IsString()
  @MinLength(32, { message: 'JWT_SECRET muss mindestens 32 Zeichen lang sein.' })
  @IsOptional()
  JWT_SECRET?: string;

  /**
   * Setzt das `Secure`-Kennzeichen am Sitzungscookie. Gehoert auf `true`,
   * sobald ein Reverse Proxy mit TLS davorsteht — im internen Testbetrieb ueber
   * http wuerde der Browser das Cookie sonst verwerfen.
   */
  @toBool()
  @IsBoolean()
  @IsOptional()
  COOKIE_SECURE: boolean = false;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  /**
   * Leere Werte entfernen, bevor irgendetwas umgewandelt oder geprueft wird.
   *
   * Docker Compose uebergibt eine nicht gesetzte Variable als `VAR=`, also als
   * leere Zeichenkette und nicht als fehlenden Wert. `@IsOptional()`
   * ueberspringt aber nur `null` und `undefined` — eine optionale Variable mit
   * Laengenpruefung fiel damit durch, sobald sie im Stack stand und leer blieb,
   * und das Backend startete nicht.
   *
   * An dieser einen Stelle behandelt, gilt es fuer jedes Feld: leer heisst
   * "nicht gesetzt", und der Vorgabewert der Klasse greift.
   */
  const provided = Object.fromEntries(
    Object.entries(raw).filter(
      ([, value]) => !(typeof value === 'string' && value.trim() === ''),
    ),
  );

  const parsed = plainToInstance(EnvironmentVariables, provided, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(parsed, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Ungueltige Umgebungskonfiguration:\n${details}`);
  }

  return parsed;
}
