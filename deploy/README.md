# Deployment

Backend und PostgreSQL als Docker-Stack, betrieben über Portainer.

## Grundentscheid: Portainer baut nicht

Der Stack startet ein fertig getaggtes Image, er baut es nicht. Das ist keine
Stilfrage, sondern eine Einschränkung von Portainer: Das Bauen aus einem
Git-Stack braucht [Relative Path Support][relpath], und den gibt es nur in der
Business Edition. In der Community Edition scheitern `build:`-Kontexte aus einem
Repository seit Jahren am selben [Fehler][issue3242].

Daraus folgt die Arbeitsteilung:

| Wer | Was |
|---|---|
| GitHub Actions (oder du auf dem Host) | baut das Image und vergibt einen Versions-Tag |
| Portainer | zieht genau diesen Tag und startet ihn |

Der Nebeneffekt ist willkommen: In Portainer steht mit `BACKEND_IMAGE` immer
sichtbar, welcher Stand läuft, und ein Rücksprung ist der vorherige Tag.

## Dateien

| Datei | Zweck |
|---|---|
| `docker-compose.yml` | Der Stack. Startet nur, baut nie. Diese Datei bekommt Portainer. |
| `docker-compose.build.yml` | Ergänzung zum Bauen von Hand, für den Host oder lokal. |
| `Dockerfile` | Mehrstufiger Build des Backends. Build-Kontext ist die Repository-Wurzel. |
| `.env.example` | Vorlage der Variablen. In Portainer werden sie in der Oberfläche gesetzt. |

---

## Teil 1 — Jetzt testen

Voraussetzung: SSH-Zugang zum Docker-Host und ein GitHub-Repository mit diesem
Stand.

### 1. Image besorgen

**Der kurze Weg:** Ist der Workflow für den gewünschten Stand gelaufen, liegt
das Image bereits in der Registry und dieser Schritt entfällt vollständig —
weiter bei Schritt 2, mit `BACKEND_IMAGE` aus [Teil 2](#ci-baut-portainer-zieht).

**Auf dem Host bauen** braucht es nur, wenn ein Stand getestet werden soll, den
die CI nicht gebaut hat:

```bash
git clone https://github.com/<org>/WiUpMo.git
cd WiUpMo
docker build -f deploy/Dockerfile -t wiupmo-backend:0.1.0 .
docker images wiupmo-backend        # sollte 0.1.0 zeigen
```

> Bewusst `docker build` statt `docker compose build`: Compose wertet beim
> Parsen die ganze Datei aus, also auch die Pflichtprüfungen auf `DB_PASSWORD`
> und `AGENT_ENROLLMENT_TOKEN`. Zum Bauen braucht es beides nicht, und ein
> `.env` mit Geheimnissen soll auf dem Host gar nicht erst nötig sein — die
> Werte gehören in Portainer. `docker-compose.build.yml` ist für den Fall
> gedacht, dass der ganze Stack ohne Portainer läuft, siehe unten.

Der Build lädt die Abhängigkeiten aus dem Netz — der Host braucht dafür einmalig
Zugriff auf `registry.npmjs.org` und `ghcr.io`/Docker Hub.

### 2. Geheimnisse erzeugen

```bash
openssl rand -base64 32   # → DB_PASSWORD
```

Mehr braucht es nicht. Das Enrollment-Token für die Agents erzeugt das Backend
beim ersten Start selbst; es steht danach im Frontend unter **Einstellungen**
und lässt sich dort auch erneuern.

### 3. Stack in Portainer anlegen

**Stacks → Add stack**, Name z. B. `wiupmo`.

Als Build-Methode **Repository**:

| Feld | Wert |
|---|---|
| Repository URL | `https://github.com/<org>/WiUpMo` |
| Repository reference | `refs/heads/main` |
| Compose path | `deploy/docker-compose.yml` |
| Authentication | einschalten, falls das Repository privat ist |

Für ein privates GitHub-Repository erwartet Portainer **Basic**-Authentifizierung:
Benutzername plus ein Personal Access Token als Passwort — das Token gehört ins
Passwortfeld, nicht in die URL.

Darunter unter **Environment variables** setzen:

```
DB_PASSWORD=<erzeugter Wert>
```

Mehr ist nicht nötig — alles Übrige hat brauchbare Standardwerte, `BACKEND_IMAGE`
eingeschlossen. AD-Anbindung, Schwellwerte und das Enrollment-Token werden im
Frontend unter **Einstellungen** gepflegt, nicht hier. Nach Bedarf zusätzlich:

| Variable | Wann |
|---|---|
| `HOST_PORT` | Auf dem Host liegt schon etwas auf 3000. Im Container bleibt es 3000, nur die Veröffentlichung wandert. |
| `BIND_ADDRESS` | `127.0.0.1`, sobald ein Reverse Proxy davorsteht. |
| `BACKEND_IMAGE` | Eine feste Version statt `:main` (produktiv). |
| `DB_USER`, `DB_NAME` | Abweichend von `wiupmo`. Nur beim allerersten Start wirksam — danach steckt es im Volume. |

> **„Re-pull image"** nur ankreuzen, wenn `BACKEND_IMAGE` auf die Registry
> zeigt. Bei einem lokal auf dem Host gebauten Image ginge der Pull-Versuch an
> Docker Hub und schlüge fehl.

Dann **Deploy the stack**.

### 4. Prüfen

Der Stack zeigt drei Container. Dass `wiupmo-migrate-1` als *exited* dasteht,
ist der Normalfall und kein Fehler — der Dienst läuft die Migrationen einmal
durch und beendet sich. Sein Protokoll muss `migration:run` ohne Fehler zeigen.

```bash
curl http://<host>:3000/health
# {"status":"ok","database":"ok","uptimeSeconds":…}
```

Die API-Dokumentation liegt unter `http://<host>:3000/api/docs`. Ist `HOST_PORT`
gesetzt, gilt überall dieser Port statt 3000 — auch für die Backend-Adresse des
Agents.

### 5. Ersten Agent melden lassen

Das Enrollment-Token steht im Frontend unter **Einstellungen → Agent-Registrierung**;
dort steht auch der fertige Aufrufbefehl zum Kopieren. Auf einem Windows-Rechner,
als Administrator:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj -c Release -r win-x64 -o agent/publish
agent\publish\wiupmo-agent.exe --install --backend-url http://<host>:3000 --enrollment-token <token>
```

Erwartete Ausgabe: eine Zeile „Registriert als Gerät …", danach „Snapshot
übermittelt (accepted)". Kontrolle in der Datenbank:

```bash
docker exec -it wiupmo-postgres-1 psql -U wiupmo -d wiupmo \
  -c "select hostname, os_name, os_build, last_seen_at from devices;"
```

---

## Teil 2 — Der dauerhafte Weg

Sobald der Stand steht, sollte der Host nichts mehr selbst bauen.

### CI baut, Portainer zieht

[`.github/workflows/backend-image.yml`](../.github/workflows/backend-image.yml)
baut bei jedem Commit an `backend/` ein Image und legt es unter
`ghcr.io/<org>/wiupmo/backend` ab. Ein Tag `backend/v0.2.0` erzeugt zusätzlich
das Image-Tag `0.2.0`. Die Registry gehört zum GitHub-Konto — es braucht keine
zusätzliche Infrastruktur.

Solange das Repository öffentlich ist, ist es auch das Paket — Portainer zieht
das Image dann ohne Zugangsdaten. Im Stack genügt:

```
BACKEND_IMAGE=ghcr.io/lucakuehne/wiupmo/backend:0.2.0
```

Wird das Repository später privat, ist einmalig in Portainer unter
**Registries** eine Registry `ghcr.io` mit einem GitHub-Token (Berechtigung
`read:packages`) zu hinterlegen.

**Immer einen festen Tag eintragen, nie `main`.** Der Branch-Tag wandert; welcher
Stand tatsächlich läuft, wäre danach nicht mehr feststellbar, und ein „Re-pull"
tauschte das Image unbemerkt aus. Für einen Zwischenstand ohne Version eignet
sich der `sha-…`-Tag, den derselbe Workflow mitschreibt.

### Aktualisieren

**In der Testphase** ist `BACKEND_IMAGE` gar nicht gesetzt. Dann gilt der
Standardwert `…/backend:main` aus der Compose-Datei, und ein Update ist:

1. Änderung nach `main` pushen — die CI baut und überschreibt den Tag `main`
2. In Portainer **Pull and redeploy**, „Re-pull image" angekreuzt

Mehr nicht. Das Ankreuzen ist dabei nicht optional: ohne Re-pull benutzt Docker
das lokal vorhandene `main` weiter, und die Änderung käme nicht an.

Wer auch den Knopfdruck sparen will, aktiviert beim Stack unter *Automatic
updates* einen Webhook und trägt ihn in den GitHub-Repository-Einstellungen ein.
Dann redeployt Portainer nach jedem Push von selbst.

**Für den produktiven Betrieb** wird stattdessen fest gepinnt:

1. Version taggen: `git tag backend/v0.2.0 && git push --tags` — die CI erzeugt daraus `:0.2.0`
2. In Portainer `BACKEND_IMAGE=ghcr.io/lucakuehne/wiupmo/backend:0.2.0` setzen
3. **Update the stack** mit „Re-pull image"

Der Unterschied ist Absicht. `main` wandert und ist deshalb bequem, solange
schnelle Iteration zählt; sobald eine Geräteflotte daran hängt, muss aus dem
Stack ablesbar sein, welcher Stand läuft — und ein Rücksprung ist dann der
vorherige Versions-Tag.

Geht etwas schief, ist der Rücksprung derselbe Ablauf mit dem alten Tag. Die
Datenbank bleibt dabei unberührt — sie liegt im Volume `wiupmo_postgres-data`.

> Migrationen sind nicht automatisch rückwärtskompatibel. Ein Rücksprung über
> eine Migration hinweg braucht vorher `migration:revert`. Solange das Schema
> nur wächst, ist das kein Thema.

**GitOps-Automatik** (Stack → *Automatic updates*) ist verlockend, taugt hier
aber nur bedingt: Sie zieht Änderungen an der Compose-Datei nach, nicht an
`BACKEND_IMAGE` — das ist eine Portainer-Variable, kein Repository-Inhalt. Der
Versionswechsel bleibt also ein bewusster Handgriff. Genau so soll es bei einem
System sein, an dem eine ganze Geräteflotte hängt.

### Agent-Versionen

Die hochgeladenen Agent-Binaries liegen im Volume `wiupmo_agent-releases`,
nicht in der Datenbank. Ein `pg_dump` sichert sie also **nicht**. Sie sind
ersetzbar — ein Release lässt sich jederzeit neu hochladen —, aber die
Zuordnung Version → Prüfsumme steckt in der Datenbank. Geht das Volume
verloren, zeigen die Einträge auf fehlende Dateien; das Backend antwortet dem
Agent dann mit 404, und der Auftrag scheitert kontrolliert.

```bash
sudo docker run --rm -v wiupmo_agent-releases:/data -v "$PWD:/backup" alpine \
  tar czf /backup/agent-releases.tar.gz -C /data .
```

### Von vorn anfangen

Wenn der Zustand auf dem Host unklar geworden ist — halb entfernte Container,
ein Stack ausserhalb von Portainer, ein Image mit unbekanntem Inhalt — ist das
Aufräumen billiger als die Fehlersuche. Solange keine Geräte gemeldet haben,
geht dabei nichts verloren.

```bash
# Alles zum Projekt entfernen, unabhaengig davon, wer es angelegt hat
docker ps -a --filter label=com.docker.compose.project=wiupmo -q | xargs -r docker rm -f
docker volume rm wiupmo_postgres-data wiupmo_agent-releases
docker network rm wiupmo_default

# Lokal gebaute Images weg, damit sie nicht unbemerkt wieder greifen
docker rmi wiupmo-backend:0.1.0
docker rmi ghcr.io/lucakuehne/wiupmo/backend:main

# Kontrolle — hier darf nichts mehr auftauchen
docker ps -a | grep wiupmo
docker volume ls | grep wiupmo
ss -lptn 'sport = :3000'
```

Danach das Image ziehen und **vor** dem Deployen prüfen, was drinsteckt:

```bash
docker pull ghcr.io/lucakuehne/wiupmo/backend:main
docker run --rm ghcr.io/lucakuehne/wiupmo/backend:main \
  grep -n 'design:type' dist/src/database/entities/device-secret.entity.js
```

Die Ausgabe muss `Object` enthalten, nicht `Device`. Diese eine Zeile beantwortet
die Frage „läuft der aktuelle Stand?", bevor ein Deployment sie teuer stellt.

### Von Test auf produktiv

Auf derselben Maschine sind es vier Punkte:

**Sicherung.** Die Datenbank ist der einzige unersetzliche Teil.

```bash
docker exec wiupmo-postgres-1 pg_dump -U wiupmo -Fc wiupmo > wiupmo-$(date +%F).dump
```

Als nächtlicher Cron-Job, Ergebnis auf ein anderes System. Ohne
Rückspielprobe ist eine Sicherung eine Vermutung.

**Erreichbarkeit.** Der Agent legt sein Geräte-Secret in jeden Request; über
HTTP liegt es im Klartext im Netz. Für den Dauerbetrieb gehört ein Reverse Proxy
mit TLS davor, `BIND_ADDRESS=127.0.0.1` und im Agent eine `https://`-Adresse.

**Zugriff auf Portainer.** Der Stack trägt `DB_PASSWORD` und
`AGENT_ENROLLMENT_TOKEN` in seinen Variablen. Wer die Portainer-Oberfläche
öffnen kann, kann jedes Gerät der Flotte registrieren.

**Token-Wechsel.** Ändert sich `AGENT_ENROLLMENT_TOKEN`, sind bereits
registrierte Geräte davon nicht betroffen — sie arbeiten mit ihrem eigenen
Secret weiter. Betroffen sind nur Neuinstallationen.

---

## Ohne Portainer

> **Nicht beides auf demselben Host.** Wird das Projekt mit `docker compose up`
> gestartet, gehört es dem Host. Portainer erkennt es dann zwar an den
> Compose-Labels und zeigt es an, meldet aber „This stack was created outside of
> Portainer. Control over this stack is limited" — und lässt weder Bearbeiten
> noch Redeploy zu. Zurück kommt man nur, indem man die Container entfernt
> (`docker rm -f …`, das Volume behalten) und den Stack in Portainer unter
> demselben Namen neu anlegt.
>
> Auf dem Docker-Host mit Portainer gilt deshalb: `docker build` ja,
> `docker compose up` nein.

Auf einem Rechner ohne Portainer lässt sich derselbe Stack direkt fahren:

```bash
cd deploy
cp .env.example .env        # Werte setzen
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose up -d
docker compose logs -f backend
```

[relpath]: https://docs.portainer.io/advanced/relative-paths
[issue3242]: https://github.com/portainer/portainer/issues/3242
