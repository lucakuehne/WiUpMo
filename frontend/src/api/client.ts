/**
 * Schmaler Aufsatz auf `fetch`.
 *
 * Zwei Dinge sind hier wichtig: `credentials: 'include'` schickt das
 * Sitzungscookie mit, und ein 401 wird als eigener Fehlertyp geworfen, damit
 * der Router darauf zur Anmeldung umleiten kann, ohne jede Fehlermeldung
 * auseinandernehmen zu muessen.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (!response.ok) {
    const error = new ApiError(response.status, await readError(response));
    handleUnauthorized(error);
    throw error;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * Wird gesetzt, sobald der Router steht. Der Umweg über einen Rückruf statt
 * eines direkten Imports vermeidet, dass sich Client und Router gegenseitig
 * importieren.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

/**
 * Eine abgelaufene Sitzung ist kein Fehler, den der Benutzer lesen soll,
 * sondern eine Aufforderung, sich neu anzumelden. Ohne diese Behandlung zeigte
 * jede Ansicht nach zwölf Stunden eine rote Meldung „Die Sitzung ist
 * abgelaufen" und blieb sonst leer.
 */
function handleUnauthorized(error: ApiError): void {
  if (error.isUnauthorized) {
    onUnauthorized?.();
  }
}

/**
 * NestJS meldet Validierungsfehler als Liste unter `message`. Die erste Zeile
 * daraus ist fuer den Benutzer brauchbarer als "Bad Request".
 */
async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      if (Array.isArray(message)) {
        return message.map(String).join(' ');
      }
      if (typeof message === 'string') {
        return message;
      }
    }
  } catch {
    // Antwort war kein JSON — dann bleibt der Statustext.
  }

  return `${response.status} ${response.statusText}`;
}

export function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<T>(`${path}${suffix}`);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

/**
 * Multipart-Upload. Ohne `Content-Type` — den setzt der Browser samt der
 * `boundary` selbst; ein von Hand gesetzter Wert ohne boundary lässt den
 * Upload serverseitig scheitern.
 */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: form, credentials: 'include' });

  if (!response.ok) {
    const error = new ApiError(response.status, await readError(response));
    handleUnauthorized(error);
    throw error;
  }

  return (await response.json()) as T;
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
