/**
 * Gemeinsame Helfer der Testskripte, die gegen eine laufende Instanz im
 * Test-Stack laufen (smoke.mjs, ad-smoke.mjs). Keine Unit-Tests: Der Name
 * endet bewusst nicht auf .test.mjs, damit `pnpm test` ihn nicht aufsammelt.
 *
 * Nur Node-Bordmittel, damit die Skripte in jedem Image laufen, das Node
 * mitbringt — auch in einem aelteren fuer den Migrationstest.
 */
import { randomUUID } from 'node:crypto';

/** Das Administratorkonto des Test-Stacks. Steht im Repository, gilt also nur dort. */
export const ADMIN = {
  username: process.env.SMOKE_USER ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'nur-fuer-den-test-stack',
};

export const AGENT_VERSION = '1.0.0-smoke';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Schutz vor einem Lauf gegen die Produktion: Die Skripte legen Konten,
 * Geraete und Einstellungen an. Im Test-Stack heisst das Backend `backend`.
 */
export function assertTestTarget(base) {
  const host = new URL(base).hostname;
  if (!['backend', 'localhost', '127.0.0.1'].includes(host) && !process.argv.includes('--erzwingen')) {
    console.error(
      `Abbruch: ${base} sieht nicht nach dem Test-Stack aus. Die Testskripte schreiben Daten ` +
        '— wer es wirklich will, haengt --erzwingen an.',
    );
    process.exit(2);
  }
}

/** HTTP-Client mit eigenem Sitzungscookie. */
export class Client {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
    this.cookie = '';
  }

  async request(method, path, { body, expect = [200, 201, 204], token, raw = false } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (token) headers.authorization = `Bearer ${token}`;

    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await fetch(this.base + path, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];

    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    const data = !raw && isJson && text ? JSON.parse(text) : text;

    const expected = Array.isArray(expect) ? expect : [expect];
    if (!expected.includes(res.status)) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    return { status: res.status, data, headers: res.headers };
  }

  async get(path, options) {
    return (await this.request('GET', path, options)).data;
  }

  async post(path, body, options = {}) {
    return (await this.request('POST', path, { ...options, body })).data;
  }

  async put(path, body, options = {}) {
    return (await this.request('PUT', path, { ...options, body })).data;
  }
}

/**
 * Fuehrt Pruefschritte nacheinander aus und laeuft nach einem Fehler weiter:
 * Ein einzelner Befund soll nicht verdecken, was danach noch kaputt ist.
 */
export function createRunner(title) {
  const results = [];

  async function step(name, fn) {
    process.stdout.write(`- ${name} ... `);
    try {
      await fn();
      results.push({ name, ok: true });
      console.log('ok');
    } catch (error) {
      results.push({ name, ok: false });
      console.log('FEHLER');
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    ${message.split('\n').join('\n    ')}`);
    }
  }

  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${title}: ${results.length - failed.length} von ${results.length} Pruefungen bestanden.`);
    if (failed.length > 0) {
      console.log(`Gescheitert: ${failed.map((f) => f.name).join('; ')}`);
      process.exitCode = 1;
    }
  }

  return { step, finish };
}

/** Meldet das Administratorkonto an; legt es an, solange die Instanz leer ist. */
export async function signIn(client) {
  const status = await client.get('/api/auth/status');
  const path = status.setupRequired ? '/api/auth/setup' : '/api/auth/login';
  await client.post(path, ADMIN);
  return status.setupRequired;
}

export const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Eine siebenstellige KB-Nummer, eindeutig genug fuer einen Testlauf. */
export const randomKb = () => String(5_000_000 + Math.floor(Math.random() * 4_000_000));

export function host(hostname, extra = {}) {
  return {
    hostname,
    osName: 'Windows 11 Pro',
    osVersion: '10.0.26100',
    osBuild: '26100.4061',
    ...extra,
  };
}

/** Ein offenes Update, wie der Agent es aus der Windows-Update-API liest. */
export function update({ kb = randomKb(), title, security = false, severity, categories = [], rebootRequired = false }) {
  return {
    updateId: randomUUID(),
    revisionNumber: 200,
    kbArticle: kb,
    title,
    ...(severity ? { severity } : {}),
    categories,
    isSecurity: security,
    sizeBytes: '73400320',
    supportUrl: `https://support.microsoft.com/help/${kb}`,
    rebootRequired,
  };
}

/** Ein Eintrag der Installationshistorie zu einem Update. */
export function history(item, { resultCode, hresult = 0, occurredAt }) {
  return {
    updateId: item.updateId,
    revisionNumber: item.revisionNumber,
    kbArticle: item.kbArticle,
    title: item.title,
    operation: 'installation',
    resultCode,
    hresult,
    occurredAt,
  };
}

export function snapshot({ hostInfo, collectedAt, available = [], entries = [], pendingReboot = false, source }) {
  return {
    snapshotId: randomUUID(),
    collectedAt,
    agentVersion: AGENT_VERSION,
    host: hostInfo,
    updateSource: source ?? {
      source: 'wsus',
      wsusServerUrl: 'http://wsus.test.local:8530',
      useWuServer: true,
      registeredServices: ['Windows Server Update Service'],
      mdmEnrolled: false,
    },
    pendingReboot,
    availableUpdates: available,
    history: entries,
    diagnostics: {
      queuedSnapshots: 0,
      updaterTaskRegistered: true,
      recentLogs: [{ at: collectedAt, level: 'Warning', message: 'Testeintrag aus dem Smoke-Test' }],
    },
  };
}

export async function enroll(client, enrollmentToken, hostInfo, expect) {
  return (
    await client.request('POST', '/api/agent/v1/enroll', {
      body: { enrollmentToken, host: hostInfo, agentVersion: AGENT_VERSION },
      expect,
    })
  ).data;
}

export async function checkin(client, token, body, expect) {
  return (await client.request('POST', '/api/agent/v1/checkin', { body, token, expect })).data;
}
