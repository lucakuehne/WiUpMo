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

### 1. Image auf dem Host bauen

```bash
git clone https://github.com/<org>/WiUpMo.git
cd WiUpMo/deploy
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker images wiupmo-backend        # sollte 0.1.0 zeigen
```

Der Build lädt die Abhängigkeiten aus dem Netz — der Host braucht dafür einmalig
Zugriff auf `registry.npmjs.org` und `ghcr.io`/Docker Hub.

### 2. Geheimnisse erzeugen

```bash
openssl rand -base64 32   # → DB_PASSWORD
openssl rand -base64 32   # → AGENT_ENROLLMENT_TOKEN
```

Das Enrollment-Token bekommt später jeder Agent beim erstmaligen Start zu sehen.
Es ist kein Dauergeheimnis pro Gerät — danach arbeitet jedes Gerät mit einem
eigenen, serverseitig erzeugten Secret.

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
BACKEND_IMAGE=wiupmo-backend:0.1.0
DB_USER=wiupmo
DB_NAME=wiupmo
DB_PASSWORD=<erzeugter Wert>
AGENT_ENROLLMENT_TOKEN=<erzeugter Wert>
PORT=3000
BIND_ADDRESS=0.0.0.0
CORS_ORIGINS=
```

> **Nicht ankreuzen:** „Re-pull image". Das Image liegt in dieser Phase nur
> lokal auf dem Host; ein Pull-Versuch ginge an Docker Hub und schlüge fehl.

Dann **Deploy the stack**.

### 4. Prüfen

Der Stack zeigt drei Container. Dass `wiupmo-migrate-1` als *exited* dasteht,
ist der Normalfall und kein Fehler — der Dienst läuft die Migrationen einmal
durch und beendet sich. Sein Protokoll muss `migration:run` ohne Fehler zeigen.

```bash
curl http://<host>:3000/health
# {"status":"ok","database":"ok","uptimeSeconds":…}
```

Die API-Dokumentation liegt unter `http://<host>:3000/api/docs`.

### 5. Ersten Agent melden lassen

Auf einem Windows-Rechner:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj -c Release -r win-x64 -o agent/publish
agent\publish\wiupmo-agent.exe --backend-url http://<host>:3000 --enrollment-token <token>
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

Einmalig in Portainer unter **Registries** eine Registry `ghcr.io` mit einem
GitHub-Token (Berechtigung `read:packages`) hinterlegen. Danach genügt im Stack:

```
BACKEND_IMAGE=ghcr.io/<org>/wiupmo/backend:0.2.0
```

### Aktualisieren

1. Änderung nach `main` pushen, Tag `backend/vX.Y.Z` setzen
2. In Portainer `BACKEND_IMAGE` auf den neuen Tag ändern
3. **Update the stack** mit angekreuztem „Re-pull image"

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

Derselbe Stack lässt sich direkt fahren:

```bash
cd deploy
cp .env.example .env        # Werte setzen
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose up -d
docker compose logs -f backend
```

[relpath]: https://docs.portainer.io/advanced/relative-paths
[issue3242]: https://github.com/portainer/portainer/issues/3242
