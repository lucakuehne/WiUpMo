# Deployment

Gebaut wird nur bei GitHub, auf dem Server läuft alles über Portainer. Vom
Laptop aus wird ausschliesslich über die Portainer-API gesteuert — lokal
laufen weder Docker noch die Anwendung.

| Wer | Was |
|---|---|
| GitHub Actions | prüft den Code (Unit-Tests, Typecheck, OpenAPI) und baut das Image nach `ghcr.io` |
| Portainer | zieht das Image und startet den Stack aus [`docker-compose.yml`](docker-compose.yml) |
| [`test-stack.ps1`](test-stack.ps1) | baut den Arbeitsstand auf dem Server und testet ihn in einem eigenen Stack |
| [`release.ps1`](release.ps1) | sichert die Datenbank, rollt aus, kontrolliert und räumt auf |

## Grundentscheid: Portainer baut nicht

Der Stack startet ein fertig getaggtes Image, er baut es nicht. Das ist keine
Stilfrage, sondern eine Einschränkung von Portainer: Das Bauen aus einem
Git-Stack braucht [Relative Path Support][relpath], und den gibt es nur in der
Business Edition. In der Community Edition scheitern `build:`-Kontexte aus einem
Repository seit Jahren am selben [Fehler][issue3242].

Das Image enthält alles: Backend, das vom Backend ausgelieferte Frontend und das
Agent-Binary. Die Datenbank läuft als eigener Dienst im selben Stack, die
Migrationen als einmaliger Dienst `migrate` vor dem Backend.

## Dateien

| Datei | Zweck |
|---|---|
| `docker-compose.yml` | Der produktive Stack. Startet nur, baut nie. Diese Datei bekommt Portainer. |
| `Dockerfile` | Mehrstufiger Build. Build-Kontext ist die Repository-Wurzel. |
| `test-stack.yml` | Der Test-Stack `wiupmo-test`: eigene Datenbank, Samba-AD, Runner, Playwright. |
| `test-stack.ps1` | Baut, startet, testet und entfernt den Test-Stack. |
| `release.ps1` | Rollt den produktiven Stack aus. |
| `tools/Portainer.psm1` | Helfer für die Portainer- und Docker-API: `Invoke-Portainer`, `Invoke-DockerExec`, Logs, Dateien hinein und heraus, Build. |
| `portainer.local.example.psd1` | Vorlage für die lokale Serverkonfiguration. |
| `docker-compose.build.yml` | Ergänzung zum Bauen von Hand, nur für einen Betrieb ohne Portainer. |
| `.env.example` | Vorlage der Variablen. In Portainer werden sie in der Oberfläche gesetzt. |

Die Testskripte liegen in [`backend/test/`](../backend/test/): `smoke.mjs`,
`ad-smoke.mjs` mit `ad-setup.sh`, `ui-smoke.mjs`.

---

## Steuerung vom Laptop einrichten

Einmalig, beides ist per `.gitignore` und `.dockerignore` ausgeschlossen —
das Repository ist öffentlich, Serveradressen und Token gehören nicht hinein:

1. **Token:** In Portainer unter *My account → Access tokens* ein API-Token
   erzeugen und als einzige Zeile in `deploy\portainer-token.txt` ablegen.
2. **Server:** `deploy\portainer.local.example.psd1` nach
   `deploy\portainer.local.psd1` kopieren und Adresse, Environment-Id und
   optional die öffentliche Adresse von WiUpMo eintragen.

Die Skripte laufen unter Windows PowerShell 5.1 und benutzen `curl.exe` und
`tar.exe` aus Windows. `Invoke-RestMethod` scheitert dort am TLS-Handshake mit
dem selbstsignierten Zertifikat von Portainer.

Die Helfer lassen sich auch direkt benutzen, etwa um im Datenbank-Container
nachzusehen:

```powershell
Import-Module .\deploy\tools\Portainer.psm1
$pg = Get-ServiceContainer -Project wiupmo -Service postgres
(Invoke-DockerExec -Container $pg.Id -User postgres -Command @('ls', '-l', '/var/lib/postgresql/sicherungen')).Stdout
```

## Ablauf eines Releases

1. **Lokal prüfen**, so wie die CI es tut:

   ```powershell
   cd backend;  pnpm build; pnpm test; pnpm check:openapi
   cd ..\frontend; pnpm typecheck
   ```

2. **Test-Stack**, mit dem Arbeitsstand vor dem Commit:

   ```powershell
   .\deploy\test-stack.ps1 -Bauen -Migrationstest
   ```

3. **Commit und Push auf `main`.** GitHub Actions
   ([`backend-image.yml`](../.github/workflows/backend-image.yml)) prüft und
   baut das Image mit den Tags `main` und `sha-<commit>`; ein Git-Tag
   `backend/v1.2.3` ergibt zusätzlich `1.2.3`.

4. **Ausrollen:**

   ```powershell
   .\deploy\release.ps1
   ```

   Das Skript

   - bricht ab, wenn der Arbeitsstand nicht committet oder `HEAD` nicht
     `origin/main` ist,
   - wartet über die GitHub-API, bis der Actions-Lauf für `HEAD` erfolgreich
     war,
   - sichert die Datenbank mit `pg_dump -Fc` nach
     `/var/lib/postgresql/sicherungen/` im Datenbank-Volume und prüft die Datei
     mit `pg_restore -l`,
   - ruft `PUT /api/stacks/<id>/git/redeploy` mit `pullImage` und **allen
     bisherigen Variablen** des Stacks auf — was dort fehlt, wäre danach weg,
   - kontrolliert: Revision des Containers (Label
     `org.opencontainers.image.revision`) gegen den Commit, Exit-Code und
     Protokoll von `migrate`, die Startmeldung, Fehler und Warnungen im Log,
     `/health` im Container und von aussen, die Zahl der Migrationen und
     Geräte in der Datenbank — nur Zahlen, keine Inhalte,
   - entfernt das alte Image, sobald kein Container es mehr benutzt.

   `-NurKontrolle` führt nur die Kontrollen aus, `-ZeigeFehler` gibt die
   Fehlerzeilen aus dem Log aus. Ein Commit, der kein neues Image braucht (nur
   Doku oder `docker-compose.yml`), geht mit `-OhneImage`.

Die Sicherungen liegen im Volume der Datenbank, nicht im Datenverzeichnis. Sie
schützen vor einer misslungenen Migration, nicht vor dem Verlust des Servers;
dafür braucht es zusätzlich eine Sicherung ausserhalb. Aufgeräumt wird dort
nicht automatisch — das Skript zeigt nach jeder Sicherung Anzahl und Platz.

### Zurückgehen

Jeder Commit hat ein eigenes Image. Zurück zu einem früheren Stand:

```powershell
.\deploy\release.ps1 -Tag sha-1a2b3c4      # setzt BACKEND_IMAGE im Stack
.\deploy\release.ps1 -Tag main             # hebt die Festlegung wieder auf
```

Solange `BACKEND_IMAGE` gesetzt ist, verweigert ein normaler Aufruf das
Ausrollen — sonst liefe weiter der festgelegte Stand, obwohl man `main` meint.

Liegt zwischen den beiden Ständen eine Migration, kennt das ältere Image das
neuere Schema nicht. Dann vor dem Zurückgehen die Sicherung von vor dem
Release zurückspielen:

```powershell
Import-Module .\deploy\tools\Portainer.psm1
$pg = Get-ServiceContainer -Project wiupmo -Service postgres
$backend = Get-ServiceContainer -Project wiupmo -Service backend
Invoke-Docker POST "/containers/$($backend.Id)/stop"
Invoke-DockerExec -Container $pg.Id -User postgres -Command @('sh', '-c',
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists "/var/lib/postgresql/sicherungen/$1"',
  'restore', 'wiupmo-<zeitpunkt>-<commit>.dump')
.\deploy\release.ps1 -Tag sha-<commit-davor>
```

## Test-Stack

Ein eigener Stack `wiupmo-test` auf demselben Server, aus
[`test-stack.yml`](test-stack.yml). Er ist von aussen nicht erreichbar, hat eine
eigene Datenbank und feste Testzugänge, die im Repository stehen. Smoke-, AD-
und Oberflächentests laufen **nur hier, nie gegen die Produktion**; die
Testskripte brechen ab, wenn die Zieladresse nicht nach dem Test-Stack aussieht.

```powershell
.\deploy\test-stack.ps1 -Bauen -Migrationstest   # voller Lauf vor einem Release
.\deploy\test-stack.ps1 -Tests Smoke -Behalten   # nur API, Stack bleibt stehen
.\deploy\test-stack.ps1 -Entfernen               # Stack samt Volumes weg
.\deploy\test-stack.ps1 -Aufraeumen              # dazu Test-Images und Build-Reste
```

| Schritt | Was passiert |
|---|---|
| `-Bauen` | Lädt ein tar des Arbeitsstands hoch — was Git kennt, ohne Ignoriertes wie `.env`, `node_modules` und das Token — und baut `wiupmo:dev` über den Build-Endpunkt der Docker-API. Das Dockerfile verzichtet deshalb auf BuildKit-Eigenheiten. |
| `-Migrationstest` | Startet das Image der Produktion (oder `-AltesImage`), legt mit `smoke.mjs --nur-daten` ein Gerät mit Check-ins an, stellt auf das neue Image um und vergleicht die Zeilen je Tabelle sowie die Zahl der Migrationen. |
| Vorbereitung | Datenbank leeren, `migrate` erneut starten, Backend neu starten, Testskripte in die Container legen. |
| `Smoke` | `smoke.mjs`: Einrichtung, Anmeldung, Registrierung, Check-ins mit Installation und Fehlschlag, Nachreichung, Duplikat, Archivierung, Auswertungen, Einstellungen, Agent-Download, Auslieferung des Frontends. |
| `Ad` | `ad-setup.sh` richtet im Samba-AD Zertifikat, OUs, Computerkonten und Benutzer ein; `ad-smoke.mjs` prüft Verbindungsprobe, Abgleich mit Archivierung und Reaktivierung und die LDAP-Anmeldung mit verschachtelter Gruppenfreigabe. |
| `Ui` | `ui-smoke.mjs` im Playwright-Container: alle Seiten hell, dunkel und schmal, Fehler im Browser. Bildschirmfotos landen in `deploy\test-results\<zeitpunkt>\`. |
| Ende | Ergebnisliste, danach wird der Stack samt Volumes entfernt — ausser mit `-Behalten`. |

Der Server hat wenig freien Speicher; die Dienste des Test-Stacks tragen
deshalb Speichergrenzen. `-Aufraeumen` entfernt `wiupmo:dev`, die Images von
Playwright, Samba und dem .NET-SDK sowie ungetaggte Zwischenstufen des Builders.
Was ein Container noch benutzt, lässt Docker stehen; `postgres:18-alpine`
gehört der Produktion und wird nie angefasst.

**Plattenplatz.** Jeder Build auf dem Server lässt mehrere GB an
Zwischenstufen liegen, und die Platte teilt er sich mit der produktiven
Datenbank. Nach vier Builds an einem Tag lief sie einmal voll, und PostgreSQL
konnte drei Minuten lang nicht schreiben. Seitdem baut `-Bauen` nur bei
mindestens 15 GB freiem Platz und entfernt die Zwischenstufen nach jedem Lauf,
auch nach einem Abbruch; `release.ps1` warnt unter 10 GB.

---

## Stack in Portainer anlegen

Einmalig. **Stacks → Add stack**, Name `wiupmo`, Build-Methode **Repository**:

| Feld | Wert |
|---|---|
| Repository URL | `https://github.com/<org>/WiUpMo` |
| Repository reference | `refs/heads/main` |
| Compose path | `deploy/docker-compose.yml` |
| Authentication | nur bei einem privaten Repository |

Darunter unter **Environment variables**:

```
DB_PASSWORD=<openssl rand -base64 32>
```

Mehr ist nicht nötig — alles Übrige hat brauchbare Standardwerte. AD-Anbindung,
Schwellwerte und das Enrollment-Token werden im Frontend unter
**Einstellungen** gepflegt. Nach Bedarf zusätzlich:

| Variable | Wann |
|---|---|
| `HOST_PORT` | Auf dem Host liegt schon etwas auf 3000. Im Container bleibt es 3000. |
| `BIND_ADDRESS` | `127.0.0.1`, sobald ein Reverse Proxy davorsteht. |
| `BACKEND_IMAGE` | Setzt `release.ps1 -Tag …`; von Hand nur in Ausnahmefällen. |
| `DB_USER`, `DB_NAME` | Abweichend von `wiupmo`. Nur beim allerersten Start wirksam. |

Solange das Repository öffentlich ist, ist es auch das Paket in `ghcr.io` —
Portainer zieht das Image ohne Zugangsdaten. Wird es privat, braucht Portainer
unter **Registries** einen Eintrag für `ghcr.io` mit einem Token
(`read:packages`).

Danach zeigt der Stack vier Container. Dass `migrate` und `prepare-releases`
als *exited* dastehen, ist der Normalfall — beide laufen einmal durch.
`.\deploy\release.ps1 -NurKontrolle` prüft den Rest.

Den ersten Agent meldet man mit dem Aufruf an, der im Frontend unter
**Einstellungen → Agent-Registrierung** zum Kopieren steht.

### Stack neu anlegen, ohne die Daten zu verlieren

Es entscheidet sich an zwei Werten, beide **vor** dem Entfernen notieren:

1. **Derselbe Stack-Name.** Compose stellt ihn den Volumes voran; aus `wiupmo`
   werden `wiupmo_postgres-data` und `wiupmo_agent-releases`. Ein anderer Name
   erzeugt leere Volumes — Geräte und Historie wären scheinbar weg.
2. **Dasselbe `DB_PASSWORD`.** PostgreSQL setzt das Passwort nur beim
   allerersten Start; ein neues führt an einem bestehenden Volume zu
   `password authentication failed`.

Portainer löscht beim Entfernen eines Stacks die Container, nicht die benannten
Volumes.

### „A stack with the normalized name 'wiupmo' already exists"

Meist liegt es an Containern mit dem Compose-Label des Projekts, die
ausserhalb von Portainer entstanden sind (`docker compose up` auf dem Host).
Portainer erkennt sie als *external stack* und beansprucht den Namen dafür.
Die Container entfernen, die Volumes stehen lassen, dann die Stack-Liste neu
laden:

```powershell
Import-Module .\deploy\tools\Portainer.psm1
Find-Container -Project wiupmo -All | ForEach-Object { Invoke-Docker DELETE "/containers/$($_.Id)?force=1" }
```

Deshalb gilt auf dem Docker-Host: **nie `docker compose up`** für dieses
Projekt — sonst gehört der Stack dem Host, und Portainer lässt weder Bearbeiten
noch Redeploy zu.

## Agent-Versionen

Das Image bringt den passenden Agent mit: Die Bauanleitung übersetzt ihn für
`win-x64` und legt ihn unter `/app/agent/` ab. Beim Start nimmt das Backend ihn
auf, sofern seine Version noch nicht hinterlegt ist. Welche Version auf die
Flotte geht, bleibt eine bewusste Entscheidung unter **Einstellungen →
Agent-Versionen** — ausser bei der Erstinstallation, solange gar keine Version
als aktuell markiert ist.

Hochgeladene Agent-Binaries liegen im Volume `wiupmo_agent-releases`, nicht in
der Datenbank; ein `pg_dump` sichert sie also nicht. Sie sind ersetzbar, die
Zuordnung Version → Prüfsumme steckt aber in der Datenbank.

Das Backend läuft als `node`, nicht als root. Der Dienst `prepare-releases`
richtet deshalb bei jedem Start den Eigentümer des Volumes — ein Volume, das
einmal als root angelegt wurde, bliebe sonst unbeschreibbar (`EACCES` beim
Upload).

## Sicherheit im Betrieb

**Erreichbarkeit.** Der Agent legt sein Geräte-Secret in jeden Request; über
HTTP liegt es im Klartext im Netz. Das Backend gehört ins Firmennetz bzw.
hinter den VPN-Zugang, nicht ins Internet.

**Zugriff auf Portainer.** Der Stack trägt `DB_PASSWORD` in seinen Variablen,
das API-Token öffnet den ganzen Docker-Server. Das Token gehört nur auf den
Laptop, der steuert.

**Token-Wechsel.** Ändert sich das Enrollment-Token, arbeiten registrierte
Geräte mit ihrem eigenen Secret weiter. Betroffen sind nur Neuinstallationen.

---

## Ohne Portainer

Auf einem Rechner ohne Portainer lässt sich derselbe Stack direkt fahren — nie
auf dem Host, auf dem Portainer den Stack verwaltet:

```bash
cd deploy
cp .env.example .env        # Werte setzen
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose up -d
docker compose logs -f backend
```

[relpath]: https://docs.portainer.io/advanced/relative-paths
[issue3242]: https://github.com/portainer/portainer/issues/3242
