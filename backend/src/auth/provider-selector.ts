import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service.js';
import { AuthProvider, AuthenticatedUser } from './auth-provider.js';
import {
  LdapAccountDisabledError,
  LdapAuthProvider,
  LdapNotAuthorizedError,
} from './ldap-auth.provider.js';
import { LocalAuthProvider } from './local-auth.provider.js';

/**
 * Waehlt den Anmeldeweg nach der Einstellung `auth.provider` — und haelt im
 * LDAP-Betrieb die lokale Hintertuer offen.
 *
 * Der Fallback ist die eigentliche Entscheidung hier. Ohne ihn sperrt ein
 * ausgefallener Domaenencontroller, ein abgelaufenes Zertifikat oder eine
 * falsch gesetzte DN-Vorlage jeden aus dem System aus — ausgerechnet in dem
 * Moment, in dem jemand hineinsehen will. Der Preis ist, dass ein lokales
 * Konto auch im LDAP-Betrieb gueltig bleibt; wer das nicht will, schaltet den
 * Fallback ab und traegt das Risiko bewusst.
 */
@Injectable()
export class ProviderSelector implements AuthProvider {
  private readonly logger = new Logger(ProviderSelector.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly local: LocalAuthProvider,
    private readonly ldap: LdapAuthProvider,
  ) {}

  /** Fuer die Anzeige im Frontend. */
  get name(): string {
    return this.lastResolved;
  }

  private lastResolved = 'local';

  async validateCredentials(username: string, password: string): Promise<AuthenticatedUser | null> {
    const auth = await this.settings.getAuth();
    this.lastResolved = auth.provider;

    if (auth.provider !== 'ldap') {
      return this.local.validateCredentials(username, password);
    }

    try {
      const user = await this.ldap.validateCredentials(username, password);
      if (user) {
        return user;
      }
    } catch (error) {
      if (error instanceof LdapAccountDisabledError || error instanceof LdapNotAuthorizedError) {
        // Ausdrueckliche Ablehnung — gesperrtes Konto oder fehlende
        // Gruppenzugehoerigkeit. Nicht ueber den lokalen Weg umgehbar, sonst
        // waere die Beschraenkung wirkungslos.
        return null;
      }
      this.logger.warn(`LDAP-Anmeldung nicht moeglich: ${String(error)}`);
    }

    if (!auth.allowLocalFallback) {
      return null;
    }

    return this.local.validateCredentials(username, password);
  }
}
