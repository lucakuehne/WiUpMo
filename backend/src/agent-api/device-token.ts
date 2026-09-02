import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Der Agent authentifiziert sich mit `Bearer <deviceId>.<secret>`.
 *
 * Beides in einem Wert zu fuehren hat einen praktischen Grund: das Backend
 * findet den passenden Hash, ohne alle Geraete durchprobieren zu muessen, und
 * der Agent muss nur eine einzige Zeichenkette geschuetzt ablegen.
 */

const SECRET_BYTES = 32;

export function generateDeviceSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function buildDeviceToken(deviceId: string, secret: string): string {
  return `${deviceId}.${secret}`;
}

export interface ParsedDeviceToken {
  deviceId: string;
  secret: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDeviceToken(token: string): ParsedDeviceToken | null {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }

  const deviceId = token.slice(0, separator);
  const secret = token.slice(separator + 1);

  // Ohne diese Pruefung landete jede beliebige Zeichenkette als uuid-Parameter
  // in der Abfrage und Postgres wuerde mit einem Typfehler antworten.
  if (!UUID_PATTERN.test(deviceId)) {
    return null;
  }

  return { deviceId, secret };
}

/**
 * Vergleicht zwei Hex-Hashes in konstanter Zeit. Bei unterschiedlicher Laenge
 * wirft `timingSafeEqual`, deshalb die Vorpruefung — die Laenge ist bei
 * SHA-256-Hex ohnehin immer gleich und damit kein Geheimnis.
 */
export function secretHashMatches(expectedHash: string, candidateHash: string): boolean {
  if (expectedHash.length !== candidateHash.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHash, 'utf8'), Buffer.from(candidateHash, 'utf8'));
}
