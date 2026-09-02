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
| [`deploy/`](deploy/) | Docker Compose | Backend und Datenbank, [Betriebsanleitung](deploy/README.md) |
| [`frontend/`](frontend/) | Vue 3 + PrimeVue | Dashboards und Listen, vom Backend ausgeliefert |

## Stand

| Phase | Inhalt | Stand |
|---|---|---|
| 1 | Schema, Backend-Grundgerüst, Enrollment, Check-in, minimaler Agent | fertig |
| 2 | Agent als Windows-Dienst, Offline-Warteschlange, `--install` | fertig |
| 3 | AD-Sync: LDAP, Scheduler, Archivierung, Sync-Protokoll | fertig |
| 4 | Frontend-Basis: Login, Geräteliste, Gerätedetail, Update-Katalog | fertig |
| 5 | Auswertungen | offen |
| 6 | Agent-Auto-Update | offen |
| 7 | Härtung: Retention-Job, LDAP-Login, Backup, Doku | offen — Einstellungsseite vorgezogen |

## Schnellstart

```bash
cd deploy
cp .env.example .env        # DB_PASSWORD und AGENT_ENROLLMENT_TOKEN setzen
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose up -d
curl http://localhost:3000/health
```

Der Stack startet ein fertig getaggtes Image und baut es nicht selbst — der
Bauschritt ist deshalb ein eigener Aufruf. Der Grund und der Weg über Portainer
stehen in [`deploy/README.md`](deploy/README.md).

Die API-Dokumentation liegt danach unter `http://localhost:3000/api/docs`.

Anschliessend auf einem Windows-Rechner, als Administrator:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj -c Release -r win-x64 -o agent/publish
agent\publish\wiupmo-agent.exe --install --backend-url http://<host>:3000 --enrollment-token <token>
```

Das richtet den Dienst `WiUpMoAgent` ein und startet ihn. Zum Prüfen ohne
Installation genügt `--once`. Details zu Betriebsarten, Konfiguration und Ablage
stehen in [`agent/README.md`](agent/README.md).

## Active Directory

Optional. Ohne `AD_URL` und `AD_BASE_DN` bleibt der Abgleich aus und das System
kennt nur Geräte, die sich über ihren Agent registriert haben.

Ist er konfiguriert, liest er in einstellbarem Intervall alle Computerkonten
unterhalb der Suchwurzel. Die Zuordnung läuft über die `objectGUID` — sie
überlebt Umbenennungen und Verschiebungen. Geräte, die im AD verschwinden,
werden **archiviert, nie gelöscht**; tauchen sie wieder auf, werden sie
reaktiviert. Der Abgleich lässt sich unter *AD-Abgleich* auch von Hand
auslösen, jeder Lauf ist dort protokolliert.

Konfiguriert wird im Frontend unter **Einstellungen**; die Werte liegen in der
Datenbank und wirken sofort, ein Neustart ist nicht nötig. Das Dienstkonto
braucht ausschliesslich Leserecht auf die Computerobjekte.

Die `AD_*`-Umgebungsvariablen in [`deploy/.env.example`](deploy/.env.example)
sind nur die Erstbefüllung beim allerersten Start und können leer bleiben.

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
