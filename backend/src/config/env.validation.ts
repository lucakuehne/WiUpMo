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
const toInt = () =>
  Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)));

const toBool = () =>
  Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === '') return undefined;
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
  const parsed = plainToInstance(EnvironmentVariables, raw, {
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
