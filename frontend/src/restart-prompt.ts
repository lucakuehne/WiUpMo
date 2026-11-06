/**
 * Der Text der Neustart-Meldung mit seinen Platzhaltern — dieselbe Regel wie
 * im Agent (Restart/PromptTemplate.cs), hier für die Vorschau in den
 * Einstellungen.
 */

export const PROMPT_PLACEHOLDERS: { name: string; description: string; example: string }[] = [
  { name: 'grund', description: 'Grund aus der Anforderung', example: 'Updates abschliessen' },
  { name: 'frist', description: 'Spätester Neustart', example: 'heute um 14:00 Uhr' },
  { name: 'verschiebungen', description: 'Noch mögliche Verschiebungen', example: '3' },
  { name: 'computer', description: 'Computername', example: 'PC-0815' },
  { name: 'benutzer', description: 'Angemeldeter Benutzer', example: 'mmuster' },
];

/**
 * Ersetzt die Platzhalter. Eine Zeile, deren Platzhalter alle leer bleiben,
 * fällt ganz weg — so verschwindet „Grund: {grund}", wenn kein Grund angegeben
 * ist. Unbekannte Platzhalter bleiben stehen; mehrere Leerzeilen werden zu einer.
 */
export function renderPromptText(template: string, values: Record<string, string>): string {
  const lines: string[] = [];

  for (const line of template.replace(/\r\n/g, '\n').split('\n')) {
    const names = [...line.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).filter((name) => name in values);
    if (names.length > 0 && names.every((name) => !values[name])) continue;
    lines.push(line.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? values[name] : whole)));
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
