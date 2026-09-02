# Windows Update Monitoring

Erfasst den Windows-Update-Zustand aller Laptops und Workstations zentral:
welche Updates offen sind, seit wann, welche installiert wurden und aus welcher
Quelle ein Gerät seine Updates überhaupt bezieht.

Der [Entwicklungsplan](entwicklungsplan-windows-update-monitoring.md) enthält
die Technologieentscheide, das Datenmodell und die Umsetzungsphasen.

## Komponenten

| Verzeichnis | Technologie | Aufgabe |
|---|---|---|
| [`agent/`](agent/) | .NET 10, Windows | Liest lokal den Update-Status und meldet ihn |
| [`backend/`](backend/) | NestJS + PostgreSQL | Nimmt Meldungen entgegen, stellt die REST-API bereit |
| [`shared/`](shared/) | OpenAPI | Vertrag zwischen Agent, Backend und Frontend |
| [`deploy/`](deploy/) | Docker Compose | Backend und Datenbank |
| `frontend/` | Vue 3 + PrimeVue | Folgt in Phase 4 |

## Stand

| Phase | Inhalt | Stand |
|---|---|---|
| 1 | Schema, Backend-Grundgerüst, Enrollment, Check-in, minimaler Agent | fertig |
| 2 | Agent als Windows-Dienst, Offline-Warteschlange, `--install` | offen |
| 3 | AD-Sync | offen |
| 4 | Frontend-Basis | offen |
| 5 | Auswertungen | offen |
| 6 | Agent-Auto-Update | offen |
| 7 | Härtung | offen |

## Schnellstart

```bash
cd deploy
cp .env.example .env        # DB_PASSWORD und AGENT_ENROLLMENT_TOKEN setzen
docker compose up -d --build
curl http://localhost:3000/health
```

Die API-Dokumentation liegt danach unter `http://localhost:3000/api/docs`.

Anschliessend auf einem Windows-Rechner:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj -c Release -r win-x64 -o agent/publish
agent\publish\wiupmo-agent.exe --backend-url http://<host>:3000 --enrollment-token <token>
```

Der erste Aufruf registriert das Gerät und meldet den ersten Snapshot. Details
zu Konfiguration und Ablage stehen in [`agent/README.md`](agent/README.md).

## Entwicklung ohne Docker

```bash
cd backend
cp .env.example .env        # DB_* auf eine lokale PostgreSQL-Instanz zeigen lassen
pnpm install
pnpm migration:run
pnpm start:dev
```

Im Entwicklungsmodus schreibt das Backend bei jedem Start den aktuellen
OpenAPI-Vertrag nach `shared/openapi.json`.
