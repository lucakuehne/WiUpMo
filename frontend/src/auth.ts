import { reactive, readonly } from 'vue';
import { get, post } from '@/api/client';
import type { AuthStatus, SessionUser } from '@/api/types';

/**
 * Anmeldezustand als einfacher reaktiver Zustand statt als Store.
 *
 * Es gibt genau einen Benutzer ohne Rollen und drei Zustaende
 * (Einrichtung offen / angemeldet / nicht angemeldet). Pinia dafuer
 * einzufuehren waere eine Abhaengigkeit ohne Gegenwert.
 */
interface State {
  loaded: boolean;
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
  provider: string;
}

const state = reactive<State>({
  loaded: false,
  setupRequired: false,
  authenticated: false,
  username: null,
  provider: 'local',
});

export const auth = readonly(state);

function apply(status: AuthStatus): void {
  state.loaded = true;
  state.setupRequired = status.setupRequired;
  state.authenticated = status.authenticated;
  state.username = status.username;
  state.provider = status.provider;
}

/**
 * Wird vor der ersten Navigation aufgerufen. `force` erzwingt eine erneute
 * Abfrage — noetig nach Ab- und Anmeldung.
 */
export async function refresh(force = false): Promise<void> {
  if (state.loaded && !force) {
    return;
  }
  apply(await get<AuthStatus>('/api/auth/status'));
}

export async function login(username: string, password: string): Promise<void> {
  const user = await post<SessionUser>('/api/auth/login', { username, password });
  state.authenticated = true;
  state.username = user.username;
  state.setupRequired = false;
}

export async function setup(username: string, password: string): Promise<void> {
  const user = await post<SessionUser>('/api/auth/setup', { username, password });
  state.authenticated = true;
  state.username = user.username;
  state.setupRequired = false;
}

export async function logout(): Promise<void> {
  await post('/api/auth/logout');
  state.authenticated = false;
  state.username = null;
}

/** Vom API-Aufsatz genutzt, wenn ein 401 zurueckkommt. */
export function markSignedOut(): void {
  state.authenticated = false;
  state.username = null;
}
