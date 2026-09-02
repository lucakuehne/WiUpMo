import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { User } from '../database/entities/index.js';
import { AuthProvider, AuthenticatedUser } from './auth-provider.js';

/**
 * Argon2id-Parameter. Die Voreinstellungen von @node-rs/argon2 entsprechen
 * bereits der OWASP-Empfehlung; sie stehen hier ausdruecklich, damit eine
 * spaetere Aenderung sichtbar ist und nicht still aus einem Paket-Update kommt.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local';

  private readonly logger = new Logger(LocalAuthProvider.name);

  /**
   * Vergleichs-Hash fuer nicht existierende Konten. Er wird einmalig aus einem
   * Zufallswert erzeugt und danach wiederverwendet, damit eine Anmeldung mit
   * unbekanntem Benutzernamen genauso lange dauert wie eine mit falschem
   * Passwort. Ohne das verraet die Antwortzeit, welche Konten existieren.
   */
  private dummyHash: Promise<string> | null = null;

  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  async validateCredentials(username: string, password: string): Promise<AuthenticatedUser | null> {
    const user = await this.users
      .createQueryBuilder('u')
      .where('lower(u.username) = lower(:username)', { username })
      .getOne();

    if (!user || !user.isActive) {
      // Trotzdem rechnen, damit die Antwortzeit nichts verraet.
      await this.safeVerify(await this.getDummyHash(), password);
      return null;
    }

    if (!(await this.safeVerify(user.passwordHash, password))) {
      return null;
    }

    await this.users.update({ id: user.id }, { lastLoginAt: new Date() });
    return { id: user.id, username: user.username };
  }

  static hashPassword(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
    return this.dummyHash;
  }

  /**
   * `verify` wirft bei einem beschaedigten Hash. Das darf keinen Serverfehler
   * ergeben — es ist schlicht eine fehlgeschlagene Anmeldung.
   */
  private async safeVerify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch (error) {
      this.logger.warn(`Hash konnte nicht geprueft werden: ${String(error)}`);
      return false;
    }
  }
}
