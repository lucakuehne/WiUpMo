/**
 * Lesbare Darstellung von LDAP-Namen.
 *
 * Ein DN wie `OU=Notebooks,OU=Clients,DC=firma,DC=local` ist eindeutig, aber
 * er liest sich von innen nach aussen und mischt Struktur mit Domäne. Für eine
 * Liste, die jemand überfliegen soll, ist die Pfadschreibweise besser:
 * `firma.local › Clients › Notebooks`.
 *
 * Der vollständige DN bleibt trotzdem erreichbar — er gehört als Hinweistext
 * an das Element, weil zwei Einheiten denselben Namen tragen können.
 */

interface DnPart {
  type: string;
  value: string;
}

/**
 * Zerlegt einen DN in seine Bestandteile.
 *
 * Getrennt wird an Kommas, denen kein Gegenschrägstrich vorausgeht: Ein Name
 * darf ein maskiertes Komma enthalten (`OU=Meier\, Hans`), und ein naives
 * `split(',')` zerrisse ihn mitten im Namen.
 */
export function splitDn(dn: string): DnPart[] {
  return dn
    .split(/(?<!\\),/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const equals = part.indexOf('=');
      if (equals < 0) {
        return { type: '', value: unescapeDnValue(part) };
      }
      return {
        type: part.slice(0, equals).trim().toLowerCase(),
        value: unescapeDnValue(part.slice(equals + 1).trim()),
      };
    });
}

function unescapeDnValue(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/** Der Domänenname aus den DC-Bestandteilen, z. B. `firma.local`. */
export function domainOfDn(dn: string): string | null {
  const parts = splitDn(dn)
    .filter((part) => part.type === 'dc')
    .map((part) => part.value);

  return parts.length > 0 ? parts.join('.') : null;
}

/**
 * Der Pfad von aussen nach innen, ohne die Domäne — also so, wie man ihn in
 * der Verwaltungskonsole durchklicken würde.
 */
export function pathOfDn(dn: string): string[] {
  return splitDn(dn)
    .filter((part) => part.type !== 'dc')
    .map((part) => part.value)
    .reverse();
}

export function formatDnPath(dn: string, separator = ' › '): string {
  const segments = [domainOfDn(dn), ...pathOfDn(dn)].filter(
    (segment): segment is string => Boolean(segment),
  );

  // Bleibt nichts übrig — etwa bei einem DN in ungewohnter Form —, ist der
  // ursprüngliche Wert immer noch besser als eine leere Zeile.
  return segments.length > 0 ? segments.join(separator) : dn;
}
