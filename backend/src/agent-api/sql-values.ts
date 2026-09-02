/**
 * Baut die VALUES-Liste einer mehrzeiligen INSERT-Anweisung samt passender
 * Parameterliste. Handgeschrieben statt ueber den Query-Builder, weil die
 * ON-CONFLICT-Klauseln hier praezise formuliert sein muessen.
 */
export function buildValuesClause(rows: unknown[][]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const chunks: string[] = [];

  for (const row of rows) {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    chunks.push(`(${placeholders.join(', ')})`);
  }

  return { text: chunks.join(', '), params };
}
