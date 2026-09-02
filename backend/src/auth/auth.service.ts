import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { Setting, User } from '../database/entities/index.js';
import { AUTH_PROVIDER, AuthProvider, AuthenticatedUser } from './auth-provider.js';
import { LocalAuthProvider } from './local-auth.provider.js';
import { SetupDto } from './dto/auth.dto.js';

/** Schluessel des Sitzungsgeheimnisses in `settings`. */
const JWT_SECRET_KEY = 'jwt_secret';

export const SESSION_COOKIE = 'wiupmo_session';

/** Gueltigkeitsdauer einer Anmeldung. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

export interface SessionPayload {
  sub: string;
  username: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (await this.isSetupRequired()) {
      // Deutlich sichtbar, weil in diesem Zustand derjenige zum Administrator
      // wird, der das Frontend als Erster erreicht.
      this.logger.warn(
        'Es existiert noch kein Benutzer. Die Einrichtungsseite ist offen — wer sie zuerst ' +
          'aufruft, legt das Administratorkonto an. Bitte zeitnah abschliessen.',
      );
    }
  }

  get providerName(): string {
    return this.provider.name;
  }

  async isSetupRequired(): Promise<boolean> {
    return (await this.users.count()) === 0;
  }

  /**
   * Legt den ersten Benutzer an. Der Aufruf ist nur gueltig, solange die
   * Tabelle leer ist — danach ist die Einrichtung dauerhaft geschlossen.
   */
  async setup(dto: SetupDto): Promise<AuthenticatedUser> {
    if (!(await this.isSetupRequired())) {
      throw new ConflictException('Die Einrichtung ist bereits abgeschlossen.');
    }

    const user = this.users.create({
      username: dto.username,
      passwordHash: await LocalAuthProvider.hashPassword(dto.password),
      isActive: true,
    });

    try {
      await this.users.save(user);
    } catch {
      // Zwei gleichzeitige Einrichtungsversuche: der zweite prallt an der
      // Eindeutigkeitsbedingung ab und darf nicht als Serverfehler enden.
      throw new ConflictException('Die Einrichtung ist bereits abgeschlossen.');
    }

    this.logger.log(`Einrichtung abgeschlossen, Administratorkonto '${user.username}' angelegt.`);
    return { id: user.id, username: user.username };
  }

  async login(username: string, password: string): Promise<AuthenticatedUser> {
    const user = await this.provider.validateCredentials(username, password);
    if (!user) {
      throw new UnauthorizedException('Benutzername oder Passwort ist falsch.');
    }
    return user;
  }

  async issueToken(user: AuthenticatedUser): Promise<string> {
    const payload: SessionPayload = { sub: user.id, username: user.username };
    return this.jwt.signAsync(payload, {
      secret: await this.getSecret(),
      expiresIn: SESSION_MAX_AGE_SECONDS,
    });
  }

  async verifyToken(token: string): Promise<SessionPayload | null> {
    try {
      return await this.jwt.verifyAsync<SessionPayload>(token, { secret: await this.getSecret() });
    } catch {
      return null;
    }
  }

  /**
   * Das Sitzungsgeheimnis kommt aus `JWT_SECRET`, sofern gesetzt — sonst wird
   * es einmalig erzeugt und in `settings` abgelegt.
   *
   * Der Grund fuer die Ablage in der Datenbank: Ein zufaellig bei jedem Start
   * erzeugtes Geheimnis wuerde bei jedem Neustart alle Anmeldungen entwerten,
   * und eine weitere Pflichtvariable im Stack ist ein Stolperstein mehr bei der
   * Einrichtung. Wer mehrere Instanzen betreibt oder rotieren will, setzt
   * `JWT_SECRET` und hat wieder die Kontrolle.
   */
  private secret: Promise<string> | null = null;

  private getSecret(): Promise<string> {
    this.secret ??= this.loadOrCreateSecret();
    return this.secret;
  }

  private async loadOrCreateSecret(): Promise<string> {
    const configured = this.config.get<string>('JWT_SECRET');
    if (configured) {
      return configured;
    }

    const existing = await this.settings.findOne({ where: { key: JWT_SECRET_KEY } });
    if (existing && typeof existing.value === 'string') {
      return existing.value;
    }

    const generated = randomBytes(32).toString('base64url');
    await this.settings.save({
      key: JWT_SECRET_KEY,
      value: generated,
      description: 'Signaturgeheimnis der Anmeldesitzungen. Aendern entwertet alle Anmeldungen.',
    });

    this.logger.log('Sitzungsgeheimnis erzeugt und in den Einstellungen abgelegt.');
    return generated;
  }
}
