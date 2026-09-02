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

# Der Container laeuft nicht als root. Das Image von node bringt den Benutzer
# `node` bereits mit.
USER node

EXPOSE 3000

# Kein Healthcheck im Image: docker-compose definiert ihn, damit er dort
# zusammen mit depends_on sichtbar ist.
CMD ["node", "dist/src/main.js"]
