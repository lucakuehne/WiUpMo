/**
 * Update-Typen, wie Windows Update sie klassifiziert.
 *
 * Der Agent meldet keine Klassifikation, sondern die Namen aller Kategorien
 * eines Updates — Klassifikation und Produkte gemischt, etwa
 * `["Security Updates", "Windows 11"]`. Jedes Update hat genau eine
 * Klassifikation; sie wird hier am Namen erkannt. Die Namen kommen auf
 * Englisch, von WSUS ebenso wie von Microsoft Update auf einem deutschen
 * Windows (dort sind nur die Titel deutsch). Die deutschen Namen stehen zur
 * Sicherheit dabei.
 */
export enum UpdateClassification {
  Security = 'security',
  Critical = 'critical',
  Definition = 'definition',
  Rollups = 'rollups',
  Updates = 'updates',
  Drivers = 'drivers',
  FeaturePacks = 'feature-packs',
  ServicePacks = 'service-packs',
  Upgrades = 'upgrades',
  Tools = 'tools',
  /** Keine bekannte Klassifikation unter den Kategorien. */
  Other = 'other',
}

/**
 * Kategorie-Namen je Typ, in der Reihenfolge der Pruefung. „Updates" steht
 * zuletzt: Der Name ist so allgemein, dass er nur zaehlen soll, wenn sonst
 * nichts passt.
 */
const CATEGORY_NAMES: ReadonlyArray<[UpdateClassification, readonly string[]]> = [
  [UpdateClassification.Security, ['Security Updates', 'Sicherheitsupdates']],
  [UpdateClassification.Critical, ['Critical Updates', 'Kritische Updates']],
  [UpdateClassification.Definition, ['Definition Updates', 'Definitionsupdates']],
  [UpdateClassification.Rollups, ['Update Rollups', 'Updaterollups', 'Update-Rollups']],
  [UpdateClassification.Drivers, ['Drivers', 'Treiber']],
  [UpdateClassification.FeaturePacks, ['Feature Packs', 'Featurepakete']],
  [UpdateClassification.ServicePacks, ['Service Packs']],
  [UpdateClassification.Upgrades, ['Upgrades']],
  [UpdateClassification.Tools, ['Tools']],
  [UpdateClassification.Updates, ['Updates']],
];

/** Alle Typen in der Reihenfolge, in der die Oberflaeche sie zeigt. */
export const UPDATE_CLASSIFICATIONS: readonly UpdateClassification[] = Object.values(UpdateClassification);

/** Bezeichnungen wie in der Oberflaeche, fuer den Export. */
export const UPDATE_CLASSIFICATION_LABELS: Record<UpdateClassification, string> = {
  [UpdateClassification.Security]: 'Sicherheitsupdates',
  [UpdateClassification.Critical]: 'Kritische Updates',
  [UpdateClassification.Definition]: 'Definitionsupdates',
  [UpdateClassification.Rollups]: 'Update-Rollups',
  [UpdateClassification.Updates]: 'Updates',
  [UpdateClassification.Drivers]: 'Treiber',
  [UpdateClassification.FeaturePacks]: 'Feature Packs',
  [UpdateClassification.ServicePacks]: 'Service Packs',
  [UpdateClassification.Upgrades]: 'Upgrades (Feature-Updates)',
  [UpdateClassification.Tools]: 'Tools',
  [UpdateClassification.Other]: 'Ohne Typ',
};

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Der Typ eines Updates als SQL-Ausdruck ueber die Zeile `alias` der Tabelle
 * `updates`.
 *
 * Ohne erkennbare Klassifikation, aber als Sicherheitsupdate markiert (MSRC-
 * Nummer oder Schweregrad), zaehlt es als Sicherheitsupdate — Microsoft Update
 * laesst die Kategorien mitunter weg.
 */
export function classificationSql(alias: string): string {
  const branches = CATEGORY_NAMES.map(
    ([type, names]) => `WHEN ${alias}.categories && ARRAY[${names.map(literal).join(', ')}]::text[] THEN '${type}'`,
  );
  return `(CASE ${branches.join(' ')} WHEN ${alias}.is_security THEN '${UpdateClassification.Security}' ELSE '${UpdateClassification.Other}' END)`;
}
