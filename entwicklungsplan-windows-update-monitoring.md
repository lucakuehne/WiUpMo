# Entwicklungsplan: Windows Update Monitoring

**Version:** 1.0
**Datum:** 2026-09-02
**Status:** Planung

---

## Inhaltsverzeichnis

1. [Systemüberblick](#1-systemüberblick)
2. [Technologieentscheide](#2-technologieentscheide)
3. [Projektstruktur](#3-projektstruktur)
4. [Datenmodell](#4-datenmodell)
5. [API-Design](#5-api-design)
6. [Agent-Design](#6-agent-design)
7. [AD-Integration](#7-ad-integration)
8. [Authentifizierung](#8-authentifizierung)
9. [Frontend-Struktur](#9-frontend-struktur)
10. [Auswertungen](#10-auswertungen)
11. [Retention](#11-retention)
12. [Deployment](#12-deployment)
13. [Umsetzungsphasen](#13-umsetzungsphasen)
14. [Risikopunkte](#14-risikopunkte)

---

## 1. Systemüberblick

Die Lösung besteht aus drei Komponenten:

| Komponente | Technologie | Aufgabe |
|---|---|---|
| **Agent** | C# / .NET 8 Worker Service | Liest lokal den Windows-Update-Status, puffert offline, meldet per HTTPS |
| **Backend** | NestJS + PostgreSQL | Nimmt Meldungen entgegen, synchronisiert AD, stellt REST-API bereit |
| **Frontend** | Vue 3 + PrimeVue | Dashboards, Geräteliste, Detailansichten, Auswertungen |

**Netzwerk:** Das Backend ist nur intern erreichbar (Firmennetz oder VPN). Keine Exposition ins Internet nötig. Ist das Backend nicht erreichbar, puffert der Agent seine Meldungen lokal und reicht sie bei der nächsten Erreichbarkeit nach.

**Scope Phase 1:** Nur Windows-Updates, nur Laptops/Workstations, nur Melden (kein Auslösen von Installationen). Server und Remote-Trigger sind bewusst ausgeklammert, das Datenmodell steht ihnen aber nicht im Weg.

---

## 2. Technologieentscheide

### Agent: C# / .NET 8 mit direktem WUApi-Zugriff

Gegenüber PSWindowsUpdate und WMI gewählt, weil:

- Native COM-API, keine externen Module auf dem Client
- Vollständige Metadaten: KB-Nummer, Severity, Kategorie, Grösse, MSRC-Nummer
- Installationshistorie über `IUpdateHistoryEntry` verfügbar
- `Win32_QuickFixEngineering` (WMI) liefert nur einen unvollständigen Teil der Historie und keine verfügbaren Updates

**Deployment: self-contained Single-File.** Die .NET-Runtime wird mitgeliefert, der Client braucht kein installiertes .NET.

```
dotnet publish -r win-x64 --self-contained true /p:PublishSingleFile=true
```

Kosten: ca. 60–70 MB statt ~1 MB. Der Vorteil — keine Runtime-Abhängigkeit, die beim Auto-Update mitgepflegt werden muss — überwiegt bei einem Agenten, der unabhängig von einer Deployment-Lösung verteilt wird.

### Agent-Ausführung: Windows-Dienst

Als Worker Service statt als Task der Aufgabenplanung, um sofort auf Ereignisse (Netzwerkwechsel, VPN-Aufbau) reagieren zu können und die Update-Choreografie sauber steuerbar zu halten.

### Backend: NestJS statt PostgREST

PostgREST eignet sich, wenn das Backend im Wesentlichen CRUD über Tabellen ist. Hier ist mehr Logik nötig: Enrollment mit Secret-Generierung, periodischer LDAP-Sync-Job, Batch-Ingest mit Deduplizierung, Agent-Binary-Auslieferung, Auto-Update-Orchestrierung. NestJS liefert zudem einen typisierten Vertrag, der mit dem Vue-Frontend geteilt werden kann.

### Agent-Authentifizierung: Enrollment-Token + Geräte-Secret

| Verfahren | Vorteil | Nachteil |
|---|---|---|
| **Enrollment-Token + Geräte-Secret** *(gewählt)* | Unabhängig von PKI und AD, funktioniert überall, Secret rotierbar, Gerät im Frontend sperrbar | Secret liegt auf dem Client (per DPAPI verschlüsselt), Enrollment-Token muss initial verteilt werden |
| Client-Zertifikat (interne PKI) | Kryptografisch stark, Auto-Enrollment über AD, Widerruf über CRL | Setzt funktionierende PKI voraus, Renewal-Handling ist Aufwand |
| Kerberos / Machine Account | Kein Secret-Management, AD als Single Source of Truth | Funktioniert nur bei DC-Erreichbarkeit → bricht den Offline-Fall; Kerberos-Auth im Linux-Container ist fummelig |

---

## 3. Projektstruktur

**Monorepo**, alle drei Komponenten in einem Repository:

```
windows-update-monitor/
├── agent/                  # .NET 8 Worker Service
│   ├── src/
│   └── tests/
├── backend/                # NestJS
│   ├── src/
│   ├── migrations/
│   └── test/
├── frontend/               # Vue 3 + PrimeVue
│   └── src/
├── shared/                 # API-Vertrag (OpenAPI / JSON Schema)
├── deploy/
│   ├── docker-compose.yml
│   └── Dockerfile          # Multi-Stage: Frontend-Build → Backend-Image
├── docs/
└── README.md
```

**Begründung:** Der API-Vertrag zwischen Agent und Backend ist der kritische Kopplungspunkt. Ändert sich das Snapshot-Format, ist das in einem Repo ein Commit statt eines koordinierten Releases über zwei Repos mit Versionsmatrix.

**Kein gemeinsames Build-System** (kein Nx, kein Turborepo). Jede Komponente behält ihr eigenes Build-Kommando. Die CI bekommt drei Jobs mit `paths`-Filter, sodass ein Frontend-Commit keinen Agent-Build auslöst.

**Versionierung:** Unabhängig pro Komponente, Tags mit Präfix (`agent/v1.2.0`, `backend/v0.5.0`). Der Agent hat einen eigenen Release-Zyklus, weil ältere Versionen im Feld bleiben — deshalb API-Versionierung (`/api/agent/v1/checkin`) von Anfang an.

---

## 4. Datenmodell

### `devices` — Geräte-Stammdaten

| Feld | Typ | Bemerkung |
|---|---|---|
| `id` | uuid PK | |
| `hostname` | text | |
| `ad_dn` | text | |
| `ad_object_guid` | uuid | **Stabiler Schlüssel** — Hostnamen ändern sich, GUIDs nicht |
| `ad_ou` | text | |
| `os_name`, `os_version`, `os_build` | text | |
| `enrolled_at`, `last_seen_at` | timestamptz | |
| `agent_version` | text | |
| `status` | enum | `active` / `archived` |
| `archived_at`, `archived_reason` | timestamptz / text | |

### `device_secrets`

Getrennt von `devices`, damit Hauptabfragen keine Credentials mitziehen.

`device_id`, `secret_hash`, `created_at`, `revoked_at`

### `updates` — Update-Katalog

Global über alle Geräte, ein Update wird einmal gespeichert.

`id`, `update_id` (WU-GUID), `kb_article`, `title`, `severity`, `categories`, `is_security`, `msrc_number`, `size_bytes`, `support_url`, `first_seen_at`

### `device_update_states` — aktueller Stand

`device_id`, `update_id`, `state` (`available` / `installed` / `failed` / `hidden` / `superseded`), `first_available_at`, `installed_at`, `result_code`, `hresult`, `reboot_required`, `last_reported_at`

### `device_update_events` — Zeitreihe (append-only)

`id`, `device_id`, `update_id`, `event_type` (`appeared` / `installed` / `failed` / `disappeared` / `hidden`), `occurred_at`, `reported_at`, `details` (jsonb)

> **Warum die Trennung:** Der aktuelle Stand ist schnell abfragbar, die Historie wächst separat und lässt sich nach Retention-Frist beschneiden, ohne den aktuellen Stand zu beschädigen.

### `device_checkins`

`id`, `device_id`, `reported_at`, `collected_at`, `snapshot_id`, `agent_version`, `update_source` (`wsus` / `microsoft_update` / `intune` / `dual_scan`), `wsus_server_url`, `pending_reboot`, `raw_snapshot` (jsonb, optional für Debugging)

### `ad_sync_runs`

`id`, `started_at`, `finished_at`, `trigger` (`scheduled` / `manual`), `devices_found`, `devices_created`, `devices_archived`, `status`, `error`

### `settings` — Key-Value für Laufzeit-Konfiguration

Sync-Intervall, Retention-Tage, Schwellwerte für „kritisch offen seit", Stale-Agent-Grenze, `auth_provider`

### `users` — lokale Benutzer (Phase 1)

`id`, `username`, `password_hash` (Argon2id), `created_at`, `last_login_at`, `is_active`

### `agent_releases`

`version`, `file_path`, `sha256`, `released_at`, `is_current`, `notes`

### `agent_update_jobs`

`device_id`, `target_version`, `state` (`pending` / `delivered` / `installing` / `done` / `failed`), `created_at`, `completed_at`, `error`

### Indizes

Mindestens auf:

- `device_update_states(device_id, state)`
- `device_update_events(device_id, occurred_at)`
- `devices(last_seen_at)`
- `devices(ad_object_guid)`
- `device_checkins(snapshot_id)` — unique, für Idempotenz

---

## 5. API-Design

### Agent-Endpunkte

Bearer-Token, ausser `/enroll`.

| Methode | Pfad | Zweck |
|---|---|---|
| `POST` | `/api/agent/v1/enroll` | Enrollment-Secret → Geräte-ID + Device-Secret |
| `POST` | `/api/agent/v1/checkin` | Vollständiger Snapshot; Antwort enthält optional Auto-Update-Auftrag |
| `POST` | `/api/agent/v1/checkin/batch` | Mehrere gepufferte Snapshots (Offline-Nachreichung) |
| `GET` | `/api/agent/v1/binary/:version` | Download des Agent-Binaries |
| `POST` | `/api/agent/v1/update-result` | Rückmeldung nach Selbst-Update |

**Snapshot-Inhalt:** verfügbare Updates, Installationshistorie seit letztem erfolgreichen Check-in, Update-Quelle, Policy-Konfiguration, Reboot-Status, Agent-Version, `snapshot_id`, `collected_at`.

### Frontend-Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/devices` | Liste mit Filter/Sort/Pagination |
| `GET` | `/api/devices/:id` | Detail inkl. aktueller Update-Zustände |
| `GET` | `/api/devices/:id/timeline` | Zeitreihe |
| `POST` | `/api/devices/:id/archive` · `/restore` | |
| `GET` | `/api/updates` | Katalog mit Betroffenen-Anzahl |
| `GET` | `/api/updates/:id/devices` | Betroffene und nicht betroffene Geräte |
| `GET` | `/api/reports/compliance` | |
| `GET` | `/api/reports/patch-age` | |
| `GET` | `/api/reports/update-sources` | |
| `GET` | `/api/reports/stale-agents` | |
| `GET` | `/api/reports/time-to-patch` | |
| `GET` | `/api/reports/missing-agents` | |
| `POST` | `/api/ad/sync` | Manueller Sync |
| `GET` | `/api/ad/sync-runs` | Sync-Historie |
| `GET`/`PUT` | `/api/settings` | |
| `POST` | `/api/agent-releases` | Neue Version hochladen |
| `POST` | `/api/devices/:id/agent-update` | Auch als Bulk-Variante |

---

## 6. Agent-Design

### Dienst-Konfiguration

| Einstellung | Wert |
|---|---|
| Startart | Automatisch (Verzögert) — verhindert Konkurrenz mit dem Boot-Vorgang |
| Konto | `LocalSystem` — nötig für WUApi und Policy-Registry-Schlüssel |
| Recovery | Neustart nach 1 min / 2 min / danach alle 10 min, Zähler-Reset nach 1 Tag |
| Binary | `%ProgramFiles%\<AppName>\` |
| Daten & Queue | `%ProgramData%\<AppName>\` |

### Ausführung

Ein `BackgroundService` mit Timer (Intervall konfigurierbar, Default 4 h), plus zusätzliche Trigger:

- Einmalig ~2 min nach Dienststart
- Bei `NetworkChange.NetworkAvailabilityChanged` bzw. `NetworkAddressChanged` — deckt den VPN-Aufbau ab, sodass gepufferte Snapshots zeitnah nachgereicht werden

> **Trigger entprellen** (min. 5 min Abstand), sonst feuert ein Netzwerkwechsel mehrfach.

### Ablauf pro Zyklus

1. Device-Secret laden (DPAPI, Machine-Scope); fehlt es → `/enroll`
2. WUApi-Suche `IsInstalled=0 and IsHidden=0`
3. `QueryHistory` seit letztem gemeldeten Zeitstempel
4. Update-Quelle, Policy-Konfiguration, Reboot-Pending erfassen
5. Snapshot mit `snapshot_id` (GUID) und `collected_at` (UTC) in SQLite-Queue schreiben
6. Gesamte Queue per `/checkin/batch` senden, bei Erfolg löschen
7. Antwort auf Auto-Update-Auftrag prüfen

> **Wichtig:** Der COM-Zugriff auf WUApi gehört in einen `Task.Run`-Aufruf mit Timeout. `ISearchResult`-Suchen können bei defekter Update-Datenbank sehr lange blockieren — der Dienst darf daran nicht hängenbleiben.

### Update-Quellen-Erkennung

Für die WSUS-Ablösung relevant, kommt über die COM-API bzw. Registry gratis mit:

- `IAutomaticUpdates2.ServiceEnabled`
- `IUpdateServiceManager2.Services` → zeigt, ob WSUS, Microsoft Update oder Intune registriert ist
- Registry `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate` → `WUServer`, `UseWUServer`, `DoNotConnectToWindowsUpdateInternetLocations`
- Intune/MDM-Enrollment über `HKLM\SOFTWARE\Microsoft\Enrollments`

Damit ist pro Gerät live sichtbar, welche Quelle es tatsächlich nutzt.

### Offline-Queue

SQLite unter `%ProgramData%\<AppName>\queue.db`, begrenzt auf 200 Snapshots bzw. 30 Tage — danach älteste verwerfen. Ohne Begrenzung wächst die Datei bei einem Laptop, der drei Monate nicht ins VPN kommt, unkontrolliert.

### Auto-Update

Ein laufender Dienst kann sich nicht selbst ersetzen. Deshalb ein separater **Updater-Task** in der Aufgabenplanung, der bei `--install` mitregistriert wird, als `SYSTEM` läuft und selbst nie Update-Ziel ist.

**Ablauf:**

1. Dienst lädt beim Check-in das neue Binary, prüft SHA256
2. Legt es als `agent.new.exe` ab, schreibt Marker-Datei
3. Updater-Task stoppt den Dienst, verschiebt die alte EXE nach `agent.bak.exe`, tauscht die neue an ihre Stelle, startet den Dienst
4. Marker löschen, Ergebnis über `/update-result` melden

**Rollback:** Startet der Dienst nach dem Tausch nicht innerhalb von ~2 min erfolgreich (Verifikations-Marker fehlt beim nächsten Updater-Lauf), `agent.bak.exe` zurückkopieren und als `failed` melden.

### Installation

EXE mit `--install` / `--uninstall`, die:

- Den Dienst per `sc.exe` / `ServiceController` registriert
- Den Updater-Task anlegt
- Verzeichnisse und ACLs setzt
- Den Dienst startet

Ein einzelner Aufruf, unabhängig von jeder Deployment-Lösung. Verteilbar per GPO-Startup-Script, manuell oder über ein beliebiges Tool.

### Logging

Rolling File unter `%ProgramData%\<AppName>\logs\` (Serilog), plus Windows Event Log für Start, Stop und Fehler.

---

## 7. AD-Integration

Nur Computerobjekte lesen. Benutzer-Sync ist für später vorgesehen.

**Konfigurierbar:** Server, Base-DN, OU-Filter, LDAP-Filter (Default `(objectClass=computer)`), Service-Account, TLS.

### Sync-Logik

| Situation | Verhalten |
|---|---|
| Match | Über `objectGUID` |
| Neu im AD | `devices`-Eintrag anlegen (`active`, ohne Enrollment → erscheint im Report „Geräte ohne Agent") |
| Im AD verschwunden | `status = archived`, **nichts löschen** |
| Wieder aufgetaucht | Automatisch reaktivieren |
| Hostname geändert | Aktualisieren, alte Daten bleiben über die GUID verknüpft |

**Ausführung:** Intervall aus `settings`, Scheduler über `@nestjs/schedule`, manueller Trigger über API. Jeder Lauf protokolliert in `ad_sync_runs`.

---

## 8. Authentifizierung

### Phase 1: Lokaler Login

Lokale Benutzertabelle, Passwort-Hashing per Argon2id, JWT als HttpOnly-Cookie. Kein Rollenmodell — alle Benutzer haben dieselben Rechte.

### Phase 2: LDAP-Bind

Der Auth-Provider wird hinter ein Interface gelegt (`AuthProvider` mit `validateCredentials()`), sodass Phase 2 den LDAP-Bind als zweite Implementierung ergänzt, ohne Controller anzufassen. Schalter `auth_provider` (`local` / `ldap`) in `settings`, Fallback auf einen lokalen Notfall-Admin auch im LDAP-Modus.

### Zum Unterschied LDAP-Bind ↔ IdP

**LDAP-Bind:** Das Backend nimmt Benutzername und Passwort entgegen und versucht damit einen Bind gegen den DC. Klappt der Bind, ist der Login gültig.
*Vorteil:* Simpel, LDAP-Anbindung ist ohnehin vorhanden. *Nachteil:* Die Anwendung sieht das Klartext-Passwort, kein SSO, kein MFA.

**IdP (OIDC/SAML):** Der Browser wird zum Identity Provider umgeleitet, dieser authentifiziert und schickt ein signiertes Token zurück.
*Vorteil:* SSO, MFA, zentrale Session-Verwaltung, Standard. *Nachteil:* Ein IdP muss existieren und konfiguriert sein.

---

## 9. Frontend-Struktur

| Ansicht | Inhalt |
|---|---|
| **Dashboard** | Kennzahlen-Kacheln (Geräte gesamt / kritisch offen / stale / Reboot pending), Trend-Chart offener Updates, Verteilung Update-Quellen |
| **Geräte** | DataTable mit Filtern (OU, Status, Patch-Alter, Update-Quelle, letzter Check-in), sortierbare Spalten, Export |
| **Gerätedetail** | Stammdaten, aktuelle offene und installierte Updates, Timeline, Check-in-Historie, Agent-Version mit Update-Button |
| **Updates** | Katalogansicht, pro KB die Betroffenen-Verteilung |
| **Reports** | Die unter [Auswertungen](#10-auswertungen) genannten Analysen als eigene Ansichten |
| **Einstellungen** | AD-Konfiguration, Intervalle, Retention, Schwellwerte, Agent-Releases, Benutzerverwaltung |

**PrimeVue-Hinweise:** DataTable mit Lazy Loading und serverseitigem Filtern (nicht alles ins Frontend laden), Chart für Trends, Timeline für die Geräte-Historie.

---

## 10. Auswertungen

### Compliance / Risiko

- Geräte mit kritischen oder sicherheitsrelevanten Updates, offen seit > N Tagen (N konfigurierbar, z. B. 14 / 30)
- Ältestes offenes Update pro Gerät („Patch-Alter") — eine einzige Kennzahl, nach der sortiert werden kann
- Verteilung OS-Build/Revision über alle Geräte — zeigt, wer beim monatlichen CU hängengeblieben ist
- Geräte mit Reboot-Pending seit > N Tagen

### Betriebliche Hygiene

- **Stale Agents:** kein Check-in seit > N Tagen — unterscheidet „Gerät ist gepatcht" von „Gerät meldet sich nicht mehr"
- **Geräte im AD ohne Agent-Installation** (Delta AD-Sync ↔ Enrollment) — die Deployment-Lücke
- Geräte mit wiederholt fehlgeschlagener Installation desselben KB, Fehlercode-Gruppierung

### WSUS-Migration

- Verteilung Update-Quelle (WSUS / Microsoft Update / Intune / Dual-Scan), pro Gerät und aggregiert
- Geräte, deren Quelle sich seit dem letzten Check-in geändert hat → Migrationsfortschritt
- Vergleich Patch-Alter: WSUS-Geräte vs. bereits migrierte Geräte

### Zeitreihe / Trend

- Anzahl offener Updates über die Zeit (Gesamtflotte) — zeigt, ob der Patch-Prozess funktioniert
- **Time-to-Patch:** Median-Tage zwischen „erstmals als verfügbar gemeldet" und „installiert", pro Severity
- **Patch-Wellen:** Installationen pro Tag/KB — macht sichtbar, ob Updates gestaffelt oder alle auf einmal durchlaufen

### Detailansichten

- Pro Gerät: Timeline aus verfügbaren und installierten Updates
- Pro KB: welche Geräte haben es, welche nicht, seit wann verfügbar

---

## 11. Retention

**Nightly Job:** `device_update_events` und `device_checkins` älter als die Retention-Frist löschen. Default 90 Tage, konfigurierbar über `settings`.

`device_update_states` bleibt unberührt — das ist der aktuelle Stand.

**Optional vorher aggregieren:** Tages-Zusammenfassungen in eine `*_daily`-Tabelle schreiben, damit Langzeit-Trends erhalten bleiben, ohne jeden Einzelevent aufzuheben.

**Bei grösserem Volumen:** `device_update_events` nach Monat partitionieren — dann ist Löschen ein `DROP PARTITION` statt eines teuren `DELETE`.

---

## 12. Deployment

**Ein Docker-Container** für Backend und Frontend, plus ein PostgreSQL-Container.

**Multi-Stage Dockerfile:**

1. Stage 1: Frontend bauen (`npm run build`)
2. Stage 2: Backend bauen
3. Stage 3: Runtime-Image, Backend liefert das statische Frontend-Build aus

**docker-compose.yml** mit Backend, PostgreSQL und einem Named Volume für die Datenbank. Agent-Releases werden in einem separaten Volume abgelegt.

**Backup:** Regelmässiger `pg_dump` der Datenbank, Aufbewahrung nach Bedarf.

---

## 13. Umsetzungsphasen

### Phase 1 — Fundament

- Datenbank-Schema und Migrationen
- NestJS-Grundgerüst
- Docker-Compose (Backend + PostgreSQL)
- Enrollment- und Check-in-Endpunkte
- Minimaler Agent, der Updates liest und meldet

**Ziel:** Ein Gerät meldet erfolgreich Daten in die Datenbank.

### Phase 2 — Agent produktionsreif

- Worker Service mit `BackgroundService`
- Netzwerk-Trigger mit Entprellung
- SQLite-Offline-Queue, Batch-Übermittlung
- Installationshistorie
- Update-Quellen-Erkennung
- `--install` mit Dienst- und Task-Registrierung, Recovery-Optionen
- Serilog + Event Log

### Phase 3 — AD-Sync

- LDAP-Anbindung
- Scheduler und manueller Trigger
- Archivierungslogik
- Sync-Protokoll

### Phase 4 — Frontend Basis

- Vue-Setup mit PrimeVue
- Lokaler Login
- Geräteliste, Gerätedetail, Update-Katalog

### Phase 5 — Auswertungen

- Report-Endpunkte
- Dashboard mit Kennzahlen und Charts
- Export

### Phase 6 — Agent-Auto-Update

- Release-Verwaltung im Backend
- Job-Mechanismus
- Updater-Task mit Stop/Tausch/Start-Choreografie
- Verifikations-Marker und Rollback-Pfad
- Frontend-Steuerung

### Phase 7 — Härtung

- Einstellungsseite
- Retention-Job
- Fehlerbehandlung
- `/health`-Endpunkt
- Backup-Konzept
- LDAP-Bind als zweiter Auth-Provider
- Dokumentation

---

## 14. Risikopunkte

Punkte, die früh Aufmerksamkeit brauchen, weil sie später teuer zu korrigieren sind:

**Zeitstempel konsequent in UTC** speichern, erst im Frontend lokalisieren. Laptops reisen.

**`collected_at` vs. `reported_at` trennen.** Der Snapshot muss den lokalen Erfassungszeitpunkt tragen, getrennt vom Empfangszeitpunkt im Backend. Sonst ist die Zeitreihe bei Offline-Nachreichung falsch.

**Idempotenz des Check-ins.** Der Agent kann denselben Snapshot mehrfach senden (Timeout, aber Backend hat verarbeitet). Eine client-seitig generierte `snapshot_id` als Unique-Constraint löst das.

**Superseded Updates.** Ein Update verschwindet aus der Verfügbar-Liste, ohne installiert zu werden — als eigenen Event-Typ `disappeared` erfassen, nicht als „installiert" interpretieren.

**WSUS-Übergangsphase.** Während der Migration können Geräte kurzzeitig gar keine Updates sehen. Das ist im Report als eigener Zustand kenntlich zu machen, sonst wirkt es wie perfekte Compliance.

**Agent-Ausfallsicherheit.** Ein Absturz des Agents darf den Client nicht beeinträchtigen. Dienst-Recovery-Optionen auf automatischen Neustart setzen, WUApi-Aufrufe mit Timeout kapseln.

**API-Versionierung von Anfang an.** Ältere Agent-Versionen bleiben im Feld — das Backend muss mehrere Versionen gleichzeitig bedienen.

**Queue-Begrenzung im Agent.** Ohne Obergrenze wächst die SQLite-Datei bei langer Offline-Zeit unkontrolliert.
