# Agent

.NET 10 Konsolenanwendung, die den Windows-Update-Zustand des Rechners liest
und an das Backend meldet.

**Stand Phase 1:** ein Durchlauf pro Aufruf — sammeln, melden, beenden. Der
Dienstbetrieb (`BackgroundService`, Netzwerk-Trigger, SQLite-Warteschlange,
`--install`) kommt in Phase 2.

## Bauen und ausführen

```powershell
dotnet build agent/WiUpMo.Agent.slnx

# Einmaliger Durchlauf gegen ein lokales Backend
agent\src\WiUpMo.Agent\bin\Debug\net10.0-windows\win-x64\wiupmo-agent.exe `
  --backend-url http://localhost:3000 `
  --enrollment-token <Wert aus AGENT_ENROLLMENT_TOKEN>
```

Veröffentlichen als eine EXE mit mitgelieferter Runtime — der Zielrechner
braucht kein installiertes .NET:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj `
  -c Release -r win-x64 -o agent/publish
```

## Konfiguration

Drei Quellen, die einander in dieser Reihenfolge überschreiben:

1. `appsettings.json` neben der EXE
2. Umgebungsvariablen mit Präfix `WIUPMO_`, z. B. `WIUPMO_Agent__BackendUrl`
3. Aufrufparameter

| Schlüssel | Aufrufparameter | Bedeutung |
|---|---|---|
| `Agent:BackendUrl` | `--backend-url` | Basisadresse des Backends. Pflicht. |
| `Agent:EnrollmentToken` | `--enrollment-token` | Nur bis zur erstmaligen Registrierung nötig. |
| `Agent:DataDirectory` | `--data-directory` | Standard `%ProgramData%\WiUpMo`. |
| `Agent:SearchOnline` | `--search-online` | `false` liest nur den lokalen Zwischenspeicher — schnell, aber möglicherweise veraltet. |
| `Agent:ComTimeoutSeconds` | — | Obergrenze pro WUApi-Aufruf, Standard 300. |
| `Agent:InitialHistoryDays` | — | Wie weit die Historie beim ersten Check-in zurückgelesen wird. |

## Ablage auf dem Gerät

Unter `%ProgramData%\WiUpMo`:

| Datei | Inhalt |
|---|---|
| `identity.dat` | Geräte-ID und Secret, mit DPAPI im Maschinenkontext verschlüsselt |
| `state.json` | Zeitstempel des zuletzt gemeldeten Historieneintrags |

Geht `identity.dat` verloren, registriert sich der Agent neu. Das Backend
erkennt das Gerät am Hostnamen wieder, die Historie bleibt erhalten.

## Rückgabewerte

| Wert | Bedeutung |
|---|---|
| 0 | Snapshot übermittelt |
| 1 | Fehler (Backend nicht erreichbar, WUApi-Fehler, Snapshot abgelehnt) |
| 2 | Konfigurationsfehler |
| 130 | Abgebrochen (Strg+C) |

## Aufbau

| Datei | Aufgabe |
|---|---|
| `Program.cs` | Ablauf eines Durchlaufs |
| `SnapshotCollector.cs` | Setzt den Snapshot aus den Einzelteilen zusammen |
| `Windows/Com.cs` | Späte Bindung an COM über IDispatch |
| `Windows/WindowsUpdateReader.cs` | Offene Updates und Installationshistorie |
| `Windows/UpdateSourceInspector.cs` | WSUS / Microsoft Update / Intune / Dual Scan |
| `Windows/HostInspector.cs` | Stammdaten und Neustart-Status |
| `Backend/BackendClient.cs` | HTTP gegen `/api/agent/v1/...` |
| `Storage/DeviceIdentityStore.cs` | Identität (DPAPI) und Fortschrittsmarker |
| `Contracts/Snapshot.cs` | Gegenstücke zu den Backend-DTOs |

### Warum späte Bindung statt `COMReference`

Der typisierte Weg über `<COMReference>` scheidet aus: die MSBuild-Aufgabe
`ResolveComReference` gibt es nur im .NET-Framework-MSBuild aus Visual Studio,
nicht unter `dotnet build`. Das wäre eine Visual-Studio-Abhängigkeit für jeden
Build und jede CI.

Innerhalb der späten Bindung fiel die Wahl auf `Type.InvokeMember` statt
`dynamic` — der Aufruf ist damit eindeutig, vor allem bei indizierten
Eigenschaften wie `Item`, und das Publish zieht den C#-Laufzeitbinder nicht mit.
