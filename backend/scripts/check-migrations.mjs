/**
 * Prueft, dass jede Migrationsdatei in der Datenquelle eingetragen ist.
 *
 * Der Anlass: Migrationen werden namentlich importiert, weil das Glob-Laden von
 * TypeORM unter ESM unzuverlaessig ist. Eine vergessene Registrierung faellt
 * dabei nirgends auf — die Datei uebersetzt anstandslos und wird nur nie
 * ausgefuehrt. Bemerkt wurde es zuletzt erst in Produktion, an einer fehlenden
 * Spalte, die Geraeteabfrage und Check-in gleichermassen abbrechen liess.
 *
 * Laeuft als Teil von `pnpm build` und damit auch im Image-Build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');

// Die Datenquelle verlangt beim Laden die Zugangsdaten. Sie werden hier nicht
// benutzt — es wird nichts verbunden —, muessen aber gesetzt sein.
for (const [name, wert] of Object.entries({
  DB_HOST: 'localhost',
  DB_USER: 'pruefung',
  DB_PASSWORD: 'pruefung',
  DB_NAME: 'pruefung',
})) {
  process.env[name] ??= wert;
}

const dateien = readdirSync(join(wurzel, 'migrations')).filter((name) => name.endsWith('.ts'));

/** Der Klassenname steht in der Datei; ihn aus dem Dateinamen zu raten waere brüchig. */
const erwartet = dateien.map((datei) => {
  const inhalt = readFileSync(join(wurzel, 'migrations', datei), 'utf8');
  const treffer = /export class (\w+)\s+implements\s+MigrationInterface/.exec(inhalt);

  if (!treffer) {
    console.error(`FEHLER: ${datei} enthaelt keine Klasse, die MigrationInterface implementiert.`);
    process.exit(1);
  }

  return { datei, klasse: treffer[1] };
});

const { dataSourceOptions } = await import('../dist/src/database/data-source.js');
const eingetragen = new Set((dataSourceOptions.migrations ?? []).map((m) => m.name));

const fehlend = erwartet.filter((eintrag) => !eingetragen.has(eintrag.klasse));

if (fehlend.length > 0) {
  console.error('FEHLER: Diese Migrationen sind nicht in data-source.ts eingetragen:');
  for (const eintrag of fehlend) {
    console.error(`  ${eintrag.datei}  (${eintrag.klasse})`);
  }
  console.error('\nSie wuerden nie ausgefuehrt. Import und Eintrag in `migrations` ergaenzen.');
  process.exit(1);
}

console.log(`Migrationen in Ordnung: ${erwartet.length} Datei(en), alle eingetragen.`);
