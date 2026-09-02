/**
 * Die Anmeldung liegt hinter diesem Interface, damit Phase 7 den LDAP-Bind als
 * zweite Implementierung ergaenzen kann, ohne Controller oder Guard anzufassen.
 * Der Schalter dafuer ist `auth_provider` in `settings`.
 */
export interface AuthenticatedUser {
  id: string;
  username: string;
}

export interface AuthProvider {
  readonly name: string;

  /**
   * Gibt den Benutzer zurueck oder `null`. Bewusst kein Werfen bei falschen
   * Zugangsdaten: der Aufrufer soll nicht zwischen "Benutzer unbekannt" und
   * "Passwort falsch" unterscheiden koennen — und der Controller nicht
   * versehentlich die Unterscheidung nach aussen tragen.
   */
  validateCredentials(username: string, password: string): Promise<AuthenticatedUser | null>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
