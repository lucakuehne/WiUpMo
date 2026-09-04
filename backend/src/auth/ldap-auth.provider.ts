import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Client } from 'ldapts';
import { Repository } from 'typeorm';
import { User } from '../database/entities/index.js';
import { SettingsService } from '../settings/settings.service.js';
import { isAdConfigured } from '../settings/settings.types.js';
import { AuthProvider, AuthenticatedUser } from './auth-provider.js';

/**
 * Anmeldung per LDAP-Bind: Das Backend versucht mit den eingegebenen
 * Zugangsdaten eine Verbindung zum Domaenencontroller. Klappt sie, ist die
 * Anmeldung gueltig.
 *
 * Das Verfahren ist bewusst einfach gehalten und hat einen Nachteil, den man
 * kennen muss: Die Anwendung sieht das Klartextpasswort. Kein SSO, kein MFA.
 * Wer das nicht will, braucht einen Identity Provider (OIDC/SAML) — der ist
 * aber ein eigenes Vorhaben und setzt voraus, dass es einen gibt.
 *
 * Die Verbindungsdaten kommen aus der AD-Konfiguration; es ist dasselbe
 * Verzeichnis. Gebunden wird jedoch mit den Zugangsdaten des Benutzers, nicht
 * mit dem Dienstkonto.
 */
@Injectable()
export class LdapAuthProvider implements AuthProvider {
  readonly name = 'ldap';

  private readonly logger = new Logger(LdapAuthProvider.name);

  constructor(
    private readonly settings: SettingsService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async validateCredentials(username: string, password: string): Promise<AuthenticatedUser | null> {
    // Ein leeres Passwort fuehrt bei vielen Verzeichnissen zu einem
    // *erfolgreichen* anonymen Bind. Ohne diese Pruefung waere jeder
    // Benutzername mit leerem Passwort eine gueltige Anmeldung.
    if (password.length === 0) {
      return null;
    }

    const [ad, auth] = await Promise.all([this.settings.getAd(), this.settings.getAuth()]);

    if (!isAdConfigured(ad)) {
      this.logger.error('LDAP-Anmeldung ist aktiv, aber es ist kein Verzeichnis konfiguriert.');
      return null;
    }

    const bindDn = auth.userDnTemplate.replace('{username}', username);

    const client = new Client({
      url: ad.url,
      timeout: ad.timeoutSeconds * 1000,
      connectTimeout: ad.timeoutSeconds * 1000,
      tlsOptions: { rejectUnauthorized: ad.tlsRejectUnauthorized },
    });

    try {
      await client.bind(bindDn, password);
    } catch (error) {
      // Zwischen "Benutzer unbekannt" und "Passwort falsch" wird bewusst nicht
      // unterschieden — weder in der Antwort noch im Protokoll.
      this.logger.debug(`LDAP-Bind fuer ${username} abgelehnt: ${String(error)}`);
      return null;
    } finally {
      await client.unbind().catch(() => {
        // Verbindung ist ohnehin am Ende.
      });
    }

    return this.linkLocalUser(username);
  }

  /**
   * Legt beim ersten erfolgreichen LDAP-Login einen lokalen Datensatz an.
   *
   * Er traegt kein brauchbares Passwort — die Anmeldung laeuft ja ueber das
   * Verzeichnis. Er existiert, damit die Anwendung eine stabile Benutzer-ID
   * hat und damit die Benutzerliste zeigt, wer sich tatsaechlich anmeldet.
   */
  private async linkLocalUser(username: string): Promise<AuthenticatedUser> {
    const existing = await this.users
      .createQueryBuilder('u')
      .where('lower(u.username) = lower(:username)', { username })
      .getOne();

    if (existing) {
      if (!existing.isActive) {
        // Im Frontend gesperrt: Das schlaegt die Auskunft des Verzeichnisses.
        this.logger.warn(`Anmeldung von ${username} abgelehnt, Konto ist gesperrt.`);
        throw new LdapAccountDisabledError();
      }

      await this.users.update({ id: existing.id }, { lastLoginAt: new Date() });
      return { id: existing.id, username: existing.username };
    }

    const created = this.users.create({
      username,
      // Ein Wert, gegen den keine Passwortpruefung je erfolgreich sein kann:
      // Argon2 erwartet eine kodierte Zeichenkette, diese ist keine.
      passwordHash: 'ldap',
      isActive: true,
      lastLoginAt: new Date(),
    });

    await this.users.save(created);
    this.logger.log(`Benutzer ${username} beim ersten LDAP-Login angelegt.`);

    return { id: created.id, username: created.username };
  }
}

/** Getrennt vom "falsches Passwort"-Fall, damit der Fallback nicht greift. */
export class LdapAccountDisabledError extends Error {
  constructor() {
    super('Das Konto ist gesperrt.');
    this.name = 'LdapAccountDisabledError';
  }
}
