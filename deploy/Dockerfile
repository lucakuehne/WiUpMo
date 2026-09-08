# syntax=docker/dockerfile:1
#
# Build-Kontext ist das Repository-Wurzelverzeichnis, nicht deploy/ — der Build
# braucht backend/ und ab Phase 4 auch frontend/.
#
#   docker build -f deploy/Dockerfile -t wium-backend .

# --- Abhaengigkeiten ---------------------------------------------------------
# Eigene Stufe, damit ein reiner Quelltext-Commit den Installationsschritt nicht
# ungueltig macht: die Ebene wird nur neu gebaut, wenn sich Manifest oder
# Lockfile aendern.
FROM node:24-alpine AS deps
WORKDIR /app
# Ohne diese Variable fragt corepack beim ersten Herunterladen von pnpm
# interaktiv nach — im Build gibt es niemanden, der antwortet, und der Schritt
# bleibt haengen bzw. bricht ab.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- Uebersetzen -------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY backend/ ./
RUN pnpm build

# --- Frontend ----------------------------------------------------------------
# Eigene Stufe mit eigenem Abhaengigkeitsbaum: ein Backend-Commit soll den
# Frontend-Build nicht ungueltig machen und umgekehrt.
FROM node:24-alpine AS frontend
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# --- Agent -------------------------------------------------------------------
# Das Agent-Binary wandert ins Image, damit es nicht bei jedem Release von Hand
# hochgeladen werden muss: Das Backend nimmt es beim Start selbst auf.
#
# Gebaut wird fuer win-x64 auf einem Linux-Container. Das ist beim .NET-SDK
# vorgesehen — ausfuehren laesst sich das Ergebnis hier nicht, erzeugen schon.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS agent
WORKDIR /src
# Die Paketquelle des Projekts, damit der Wiederherstellungsschritt nicht von
# der Konfiguration des Bauers abhaengt.
COPY NuGet.config ./
COPY agent/ ./agent/
RUN dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj \
      -c Release -r win-x64 -o /agent-publish

# --- Laufzeit ----------------------------------------------------------------
# Nur Produktivabhaengigkeiten, kein Quelltext, kein pnpm-Store.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Ohne diese Variable fragt corepack beim ersten Herunterladen von pnpm
# interaktiv nach — im Build gibt es niemanden, der antwortet, und der Schritt
# bleibt haengen bzw. bricht ab.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

# Das Backend liefert das Frontend aus diesem Verzeichnis aus (siehe
# ServeStaticModule in app.module.ts). Fehlt es — etwa in der Entwicklung —,
# laeuft das Backend als reine API weiter.
COPY --from=frontend /app/dist ./public

# Nur die EXE, nicht das ganze Publish-Verzeichnis: Sie ist eigenstaendig, alles
# andere daneben sind Symboldateien und die Konfigurationsvorlage.
COPY --from=agent /agent-publish/wiupmo-agent.exe ./agent/wiupmo-agent.exe

# Ablage der Agent-Binaries. Sie muss im Image liegen und `node` gehoeren:
# Haengt Docker ein noch leeres benanntes Volume ein, uebernimmt es Inhalt und
# Eigentuemer des Verzeichnisses aus dem Image. Fehlt es hier, legt Docker den
# Einhaengepunkt selbst an — dann gehoert er root, und der Prozess kann darin
# nichts anlegen.
RUN mkdir -p /app/agent-releases && chown node:node /app/agent-releases

# Der Container laeuft nicht als root. Das Image von node bringt den Benutzer
# `node` bereits mit.
USER node

EXPOSE 3000

# Kein Healthcheck im Image: docker-compose definiert ihn, damit er dort
# zusammen mit depends_on sichtbar ist.
CMD ["node", "dist/src/main.js"]
