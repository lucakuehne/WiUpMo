/**
 * Klartext zu den Fehlercodes von Windows Update.
 *
 * Angezeigt wird immer beides: Der Code ist das, was man in eine Suche
 * eintippt und was in jedem Microsoft-Dokument steht; der Text ist das, was man
 * beim Überfliegen einer Liste braucht. Eines von beidem wegzulassen macht die
 * Spalte entweder unlesbar oder unbrauchbar zum Weitersuchen.
 *
 * Bewusst nur die Codes, die im Betrieb tatsächlich vorkommen — eine
 * vollständige Liste hätte hunderte Einträge, von denen niemand je einen sieht.
 * Was fehlt, erscheint als blosser Code und ist damit weiterhin auffindbar.
 *
 * Der Agent führt eine eigene, kleinere Liste für die Fehler, die ihm beim
 * Zugriff auf die Windows-Update-API begegnen (`Windows/Com.cs`). Die
 * Doppelung ist gewollt: Dort geht es um den Moment des Zugriffs, hier um die
 * Auswertung im Nachhinein, und die Formulierungen unterscheiden sich
 * entsprechend.
 */
const DESCRIPTIONS: Record<number, string> = {
  // --- Allgemeine Windows-Fehler ------------------------------------------
  0x80070002: 'Eine benötigte Datei wurde nicht gefunden.',
  0x80070005: 'Zugriff verweigert.',
  0x8007000e: 'Zu wenig Arbeitsspeicher.',
  0x80070070: 'Zu wenig Speicherplatz auf dem Datenträger.',
  0x80070422: 'Der Windows-Update-Dienst ist deaktiviert.',
  0x800705b4: 'Zeitüberschreitung.',
  0x80073712: 'Der Komponentenspeicher ist beschädigt — DISM bzw. SFC prüfen.',

  // --- Signatur und Servicing ---------------------------------------------
  0x800b0100: 'Keine gültige Signatur an der Update-Datei.',
  0x800f081f: 'Die Installationsquelle fehlt.',
  0x800f0922:
    'Die Installation ist fehlgeschlagen. Häufigste Ursache: zu wenig Platz auf der ' +
    'Systempartition.',

  // --- Ablauf und Abbruch --------------------------------------------------
  0x8024000b: 'Der Vorgang wurde abgebrochen.',
  0x8024001e: 'Der Vorgang wurde abgebrochen — meist, weil der Rechner heruntergefahren wurde.',
  0x80240017: 'Das Update ist für dieses System nicht anwendbar.',
  0x80240020: 'Für die Installation fehlt ein angemeldeter Benutzer.',
  0x80240022: 'Alle Updates dieses Durchgangs sind fehlgeschlagen.',
  0x80240024: 'Es sind keine Updates verfügbar.',
  0x8024002e: 'Der Zugriff auf Windows Update ist per Richtlinie gesperrt.',
  0x80240034: 'Der Download ist fehlgeschlagen.',

  // --- Update-Handler ------------------------------------------------------
  0x80242006: 'Die Metadaten des Updates sind ungültig.',
  0x8024200b: 'Das Installationsprogramm des Updates ist fehlgeschlagen.',
  0x80242014: 'Eingespielt — der Abschluss steht bis zum Neustart aus.',
  0x80242015: 'Das Ergebnis nach dem Neustart liess sich nicht ermitteln.',
  0x80242016: 'Unerwarteter Zustand nach dem Neustart.',
  0x80246007: 'Das Update wurde nicht heruntergeladen.',

  // --- Verbindung zur Update-Quelle ---------------------------------------
  0x8024401c: 'Zeitüberschreitung beim Zugriff auf die Update-Quelle.',
  0x80244022: 'Die Update-Quelle antwortet mit „Dienst nicht verfügbar".',
  0x8024402c:
    'Der Name der Update-Quelle liess sich nicht auflösen — meist ein Gerät ausserhalb des ' +
    'Firmennetzes.',
  0x8024500c: 'Der Zugriff wurde durch eine Richtlinie abgelehnt.',
};

/** `0x80242014`. Der Agent liefert den Wert vorzeichenbehaftet. */
export function formatHresultCode(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Der Klartext, sofern der Code bekannt ist. */
export function describeHresult(value: number): string | null {
  return DESCRIPTIONS[value >>> 0] ?? null;
}
