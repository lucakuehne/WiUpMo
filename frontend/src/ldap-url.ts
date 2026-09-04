/**
 * Zerlegt und baut die LDAP-Adresse.
 *
 * Im Formular stehen Host, Port und TLS getrennt — eine von Hand getippte URL
 * ist eine der häufigsten Fehlerquellen: falsches Schema, vergessener Port,
 * `ldaps` auf 389. Gespeichert wird trotzdem eine URL, weil die
 * LDAP-Bibliothek eine erwartet.
 */

export interface LdapUrlParts {
  host: string;
  port: number;
  secure: boolean;
}

export const LDAP_PORT = 389;
export const LDAPS_PORT = 636;

export function parseLdapUrl(url: string): LdapUrlParts {
  const fallback: LdapUrlParts = { host: '', port: LDAPS_PORT, secure: true };

  if (!url) {
    return fallback;
  }

  const match = /^(ldaps?):\/\/([^/:]+)(?::(\d+))?/i.exec(url.trim());
  if (!match) {
    return fallback;
  }

  const secure = match[1].toLowerCase() === 'ldaps';

  return {
    host: match[2],
    port: match[3] ? Number(match[3]) : secure ? LDAPS_PORT : LDAP_PORT,
    secure,
  };
}

export function buildLdapUrl(parts: LdapUrlParts): string {
  if (!parts.host.trim()) {
    return '';
  }
  return `${parts.secure ? 'ldaps' : 'ldap'}://${parts.host.trim()}:${parts.port}`;
}

/** Beim Umschalten von TLS den Standardport mitziehen — aber nur, wenn er noch der Standard war. */
export function adjustPortForScheme(parts: LdapUrlParts, secure: boolean): number {
  const wasDefault = parts.port === (parts.secure ? LDAPS_PORT : LDAP_PORT);
  return wasDefault ? (secure ? LDAPS_PORT : LDAP_PORT) : parts.port;
}
