/**
 * Ob eine gemeldete Agent-Version mindestens eine bestimmte ist.
 *
 * Verglichen werden die Zahlen von `Haupt.Neben.Fix` einzeln, damit `0.10.0`
 * nach `0.9.0` kommt — als Text verglichen waere es umgekehrt. Ein Zusatz wie
 * `-beta` zaehlt nicht; der Agent vergibt keine, nur Tests tun es.
 */
export function isVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (!version) {
    return false;
  }

  const parts = (value: string): number[] =>
    value
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const have = parts(version);
  const need = parts(minimum);

  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const difference = (have[i] ?? 0) - (need[i] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }

  return true;
}
