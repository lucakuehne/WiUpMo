# Agent

.NET 10 Windows-Dienst, der den Windows-Update-Status des Rechners liest, offline
puffert und an das Backend meldet.

## Installation

Ein einzelner Aufruf, unabhängig von jeder Verteilungslösung — verteilbar per
GPO-Startskript, von Hand oder über ein beliebiges Werkzeug:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj -c Release -r win-x64 -o agent/publish

# Als Administrator:
agent\publish\wiupmo-agent.exe --install `
  --backend-url https://wium.intern:3000 `
  --enrollment-token <Wert aus AGENT_ENROLLMENT_TOKEN>
```

Das richtet ein:

| | |
|---|---|
| Programm | `%ProgramFiles%\WiUpMo\wiupmo-agent.exe` samt `appsettings.json` |
| Dienst | `WiUpMoAgent`, Start **Automatisch (Verzögert)**, Konto `LocalSystem` |
| Wiederherstellung | Neustart nach 1 min / 2 min / danach alle 10 min, Zähler-Reset nach einem Tag |
| Daten | `%ProgramData%\WiUpMo` mit den von `%ProgramData%` geerbten Rechten |
| Ereignisquelle | `WiUpMo Agent` im Anwendungsprotokoll |

`--install` auf einem bereits eingerichteten Rechner hält den Dienst an,
ersetzt das Programm und startet ihn wieder — damit ist es zugleich der
Aktualisierungsweg, bis Phase 6 das Selbst-Update bringt.

`--uninstall` entfernt den Dienst und lässt das Datenverzeichnis stehen; dort
liegen Geräteidentität und Protokolle.

> Das Konto `LocalSystem` ist nicht verhandelbar: WUApi und die
> Richtlinien-Registrierungsschlüssel sind für normale Benutzer nicht lesbar.

## Betriebsarten

| Aufruf | Verhalten |
|---|---|
| *(ohne Argumente)* | Dauerlauf im Vordergrund — praktisch zum Beobachten |
| `--once` | Ein Durchlauf, dann beenden. Zum Prüfen einer Installation. |
| `--install` / `--uninstall` | Dienst einrichten bzw. entfernen (Administratorrechte) |

> `--once` greift auf dieselbe Warteschlange zu wie der Dienst. Läuft der
> Dienst, sind zwei gleichzeitige Durchläufe zwar unschädlich — SQLite
> serialisiert die Schreibzugriffe —, aber unnötig. Zum Prüfen genügt ein Blick
> ins Protokoll.

Im Dienstbetrieb läuft ein Durchlauf:

- **alle 4 Stunden** (`CheckIntervalHours`),
- **einmalig 2 Minuten nach Dienststart** (`StartupDelaySeconds`) — nicht sofort,
  weil eine Update-Suche während des Systemhochlaufs mit allem anderen um Platte
  und Netz konkurriert,
- **bei Netzwerkwechseln**, entprellt auf mindestens 5 Minuten Abstand
  (`NetworkDebounceMinutes`).

Der Netzwerk-Trigger ist der Grund, warum es ein Dienst ist und keine geplante
Aufgabe: Baut ein Laptop das VPN auf, sollen die gepufferten Meldungen sofort
nachgereicht werden statt bis zum nächsten Intervall zu warten. Die Entprellung
ist dabei kein Detail — ein einzelner VPN-Aufbau erzeugt eine ganze Reihe von
Ereignissen, und ohne Mindestabstand liefe der Agent mehrfach hintereinander los.

## Ablauf eines Durchlaufs

1. WUApi-Suche `IsInstalled=0 and IsHidden=0`
2. `QueryHistory` seit dem letzten gemeldeten Zeitstempel
3. Update-Quelle, Richtlinien und Neustart-Status erfassen
4. Snapshot mit `snapshotId` und `collectedAt` (UTC) in die SQLite-Warteschlange
5. Gesamte Warteschlange per `/checkin/batch` senden
6. Quittierte Snapshots löschen — auch abgelehnte, die werden durch Wiederholen
   nicht besser und blockierten die Warteschlange sonst dauerhaft

Erfassen und Senden sind getrennt. Nach Schritt 4 liegt der Snapshot dauerhaft
vor; ob das Backend gerade erreichbar ist, spielt für die Erfassung keine Rolle
mehr. Genau das macht den Offline-Betrieb aus.

## Konfiguration

Drei Quellen, die einander in dieser Reihenfolge überschreiben:

1. `appsettings.json` neben der EXE
2. Umgebungsvariablen mit Präfix `WIUPMO_`, z. B. `WIUPMO_Agent__BackendUrl`
3. Aufrufparameter

| Schlüssel | Aufrufparameter | Standard | Bedeutung |
|---|---|---|---|
| `Agent:BackendUrl` | `--backend-url` | — | Basisadresse des Backends. Pflicht. |
| `Agent:EnrollmentToken` | `--enrollment-token` | — | Nur bis zur erstmaligen Registrierung nötig. |
| `Agent:DataDirectory` | `--data-directory` | `%ProgramData%\WiUpMo` | |
| `Agent:CheckIntervalHours` | `--interval-hours` | 4 | Abstand regulärer Durchläufe. |
| `Agent:StartupDelaySeconds` | — | 120 | Wartezeit nach Dienststart. |
| `Agent:NetworkDebounceMinutes` | — | 5 | Mindestabstand netzwerkausgelöster Durchläufe. |
| `Agent:QueueMaxSnapshots` | — | 200 | Obergrenze der Warteschlange. |
| `Agent:QueueMaxAgeDays` | — | 30 | Höchstalter in der Warteschlange. |
| `Agent:SearchOnline` | `--search-online` | true | `false` liest nur den lokalen Zwischenspeicher. |
| `Agent:ComTimeoutSeconds` | — | 300 | Obergrenze pro WUApi-Aufruf. |
| `Agent:InitialHistoryDays` | — | 90 | Rückblick beim allerersten Check-in. |
| `Agent:LogRetentionDays` | — | 14 | Aufbewahrung der Protokolldateien. |

## Ablage auf dem Gerät

Unter `%ProgramData%\WiUpMo`:

| Datei | Inhalt |
|---|---|
| `identity.dat` | Geräte-ID und Secret, mit DPAPI im Maschinenkontext verschlüsselt |
| `queue.db` | Offline-Warteschlange und Fortschrittsmarker der Historie |
| `logs\agent-*.log` | Tagesrotierendes Protokoll |

Geht `identity.dat` verloren, registriert sich der Agent neu. Das Backend erkennt
das Gerät am Hostnamen wieder, die Historie bleibt erhalten.

Der Fortschrittsmarker liegt bewusst **in** `queue.db` und wird in derselben
Transaktion fortgeschrieben wie der Snapshot. Läge er daneben, könnte ein
Absturz zwischen beiden Schreibvorgängen dazu führen, dass Historieneinträge ein
zweites Mal gemeldet werden — und weil `device_update_events` im Backend rein
anhängend ist, entstünden daraus doppelte Ereignisse in der Zeitreihe.

## Protokollierung

Rollierende Tagesdatei unter `%ProgramData%\WiUpMo\logs\`. Zusätzlich gehen im
Dienstbetrieb **Warnungen und Fehler** ins Windows-Anwendungsprotokoll (Quelle
`WiUpMo Agent`). Bewusst nur diese: Das Ereignisprotokoll ist der Ort, an dem
ein Administrator nachsieht, der vom Agent nichts weiss — mit jedem
Vier-Stunden-Durchlauf vollgeschrieben wäre es dafür wertlos.

## Rückgabewerte

| Wert | Bedeutung |
|---|---|
| 0 | Erfolgreich beendet |
| 1 | Fehler |
| 2 | Konfigurationsfehler bzw. fehlende Administratorrechte bei `--install` |

## Aufbau

| Datei | Aufgabe |
|---|---|
| `Program.cs` | Kommandos, Host, Serilog, Abhängigkeiten |
| `Worker.cs` | Dienstschleife: Intervall, Trigger, Fehlerbehandlung |
| `AgentCycle.cs` | Ein Durchlauf: erfassen, ablegen, übermitteln |
| `CheckinTrigger.cs` | Netzwerkereignisse mit Entprellung |
| `SnapshotCollector.cs` | Setzt den Snapshot aus den Einzelteilen zusammen |
| `Storage/SnapshotQueue.cs` | SQLite-Warteschlange und Fortschrittsmarker |
| `Storage/DeviceIdentityStore.cs` | Identität (DPAPI) |
| `Install/ServiceInstaller.cs` | `--install` / `--uninstall` |
| `Windows/Com.cs` | Späte Bindung an COM über IDispatch |
| `Windows/WindowsUpdateReader.cs` | Offene Updates und Installationshistorie |
| `Windows/UpdateSourceInspector.cs` | WSUS / Microsoft Update / Intune / Dual Scan |
| `Windows/HostInspector.cs` | Stammdaten und Neustart-Status |
| `Backend/BackendClient.cs` | HTTP gegen `/api/agent/v1/...` |
| `Contracts/` | Gegenstücke zu den Backend-DTOs, gemeinsame JSON-Einstellungen |

### Warum späte Bindung statt `COMReference`

Der typisierte Weg über `<COMReference>` scheidet aus: die MSBuild-Aufgabe
`ResolveComReference` gibt es nur im .NET-Framework-MSBuild aus Visual Studio,
nicht unter `dotnet build`. Das wäre eine Visual-Studio-Abhängigkeit für jeden
Build und jede CI.

Innerhalb der späten Bindung fiel die Wahl auf `Type.InvokeMember` statt
`dynamic` — der Aufruf ist damit eindeutig, vor allem bei indizierten
Eigenschaften wie `Item`, und das Publish zieht den C#-Laufzeitbinder nicht mit.

### Noch offen

Der **Updater-Task** aus dem Entwicklungsplan wird von `--install` bewusst noch
nicht angelegt. Er hätte in Phase 2 kein Ziel: Ein geplanter Task, der ein
Selbst-Update ausführen soll, das es noch nicht gibt, wäre nur eine
Angriffsfläche. Er kommt mit Phase 6, zusammen mit der Release-Verwaltung im
Backend und der Stop/Tausch/Start-Choreografie.
