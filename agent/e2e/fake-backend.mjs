/**
 * Ein Backend fuer den Ende-zu-Ende-Test des Agents — nur die Schnittstelle,
 * die der Agent spricht, ohne Datenbank und ohne Pruefung der Inhalte.
 *
 * Der Vertrag mit dem echten Backend wird im Smoke-Test geprueft. Hier geht es
 * um den Agent: Registrierung, Check-in, und vor allem das Selbst-Update —
 * Auftrag ausliefern, Binary herunterladen lassen, Rueckmeldungen festhalten.
 *
 * Gesteuert wird ueber /control:
 *   POST /control/offer  { version, file }  bietet ein Update an
 *   GET  /control/state                     was bisher geschah
 *
 *   node agent/e2e/fake-backend.mjs [Port]
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 5080);

const state = {
  enrollments: 0,
  checkins: 0,
  /** Der zuletzt empfangene Snapshot, gekuerzt auf das, was der Test prueft. */
  lastCheckin: null,
  /** Alle Rueckmeldungen zu Update-Auftraegen, in Reihenfolge. */
  reports: [],
  /** Der angebotene Auftrag; ausgeliefert, solange er pending oder delivered ist. */
  job: null,
};

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function recordCheckin(snapshots) {
  state.checkins += snapshots.length;
  const last = snapshots.at(-1);
  if (last) {
    state.lastCheckin = {
      at: new Date().toISOString(),
      agentVersion: last.agentVersion,
      collectedAt: last.collectedAt,
      diagnostics: last.diagnostics ?? null,
    };
    log(`Check-in von ${last.agentVersion} (${snapshots.length} Snapshot(s))`);
  }

  // Ausgeliefert wird wie im echten Backend: bis der Agent "installing" meldet.
  let agentUpdate = null;
  if (state.job && ['pending', 'delivered'].includes(state.job.state)) {
    state.job.state = 'delivered';
    agentUpdate = {
      jobId: state.job.jobId,
      targetVersion: state.job.targetVersion,
      sha256: state.job.sha256,
      downloadPath: state.job.downloadPath,
    };
    log(`Auftrag ${state.job.jobId} auf ${state.job.targetVersion} ausgeliefert`);
  }

  return {
    results: snapshots.map((snapshot) => ({ snapshotId: snapshot.snapshotId, outcome: 'accepted' })),
    agentUpdate,
    checkIntervalMinutes: 5,
    installRequest: null,
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const route = `${request.method} ${url.pathname}`;

    if (route === 'POST /api/agent/v1/enroll') {
      const body = await readBody(request);
      state.enrollments++;
      const deviceId = randomUUID();
      const deviceSecret = randomUUID().replaceAll('-', '');
      log(`Registrierung von ${body.host?.hostname} mit ${body.agentVersion}`);
      return json(response, 201, { deviceId, deviceSecret, token: `${deviceId}.${deviceSecret}` });
    }

    if (route === 'POST /api/agent/v1/checkin/batch') {
      const body = await readBody(request);
      return json(response, 200, recordCheckin(body.snapshots ?? []));
    }

    if (route === 'POST /api/agent/v1/checkin') {
      const body = await readBody(request);
      return json(response, 200, recordCheckin([body]));
    }

    if (route === 'POST /api/agent/v1/update-result') {
      const body = await readBody(request);
      state.reports.push({ ...body, at: new Date().toISOString() });
      if (state.job?.jobId === body.jobId) {
        state.job.state = body.state;
      }
      log(`Rueckmeldung ${body.jobId}: ${body.state}${body.error ? ` — ${body.error}` : ''}`);
      return json(response, 200, { ok: true });
    }

    if (route === 'POST /api/agent/v1/install-result') {
      return json(response, 200, { ok: true });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/agent/v1/binary/')) {
      if (!state.job) return json(response, 404, { message: 'Kein Auftrag.' });
      const size = statSync(state.job.file).size;
      log(`Download ${state.job.targetVersion} (${size} Bytes)`);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
      return createReadStream(state.job.file).pipe(response);
    }

    if (route === 'POST /control/offer') {
      const body = await readBody(request);
      const sha256 = createHash('sha256').update(readFileSync(body.file)).digest('hex');
      state.job = {
        jobId: randomUUID(),
        targetVersion: body.version,
        sha256,
        downloadPath: `/api/agent/v1/binary/${body.version}`,
        file: body.file,
        state: 'pending',
      };
      log(`Angeboten: ${body.version} (${body.file})`);
      return json(response, 200, state.job);
    }

    if (route === 'GET /control/state') {
      return json(response, 200, state);
    }

    return json(response, 404, { message: `Unbekannt: ${route}` });
  } catch (error) {
    log(`Fehler: ${error.stack ?? error}`);
    return json(response, 500, { message: String(error) });
  }
});

server.listen(port, '127.0.0.1', () => log(`Test-Backend auf http://127.0.0.1:${port}`));
