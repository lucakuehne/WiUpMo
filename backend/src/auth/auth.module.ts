import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LdapModule } from '../ad/ldap.module.js';
import { Setting, User } from '../database/entities/index.js';
import { SettingsCoreModule } from '../settings/settings-core.module.js';
import { AUTH_PROVIDER } from './auth-provider.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LdapAuthProvider } from './ldap-auth.provider.js';
import { LocalAuthProvider } from './local-auth.provider.js';
import { ProviderSelector } from './provider-selector.js';
import { SessionGuard } from './session.guard.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Setting]),
    SettingsCoreModule,
    LdapModule,
    // Ohne globales Geheimnis: es wird pro Aufruf aus den Einstellungen bzw.
    // aus JWT_SECRET geholt, siehe AuthService.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LocalAuthProvider,
    LdapAuthProvider,
    ProviderSelector,
    SessionGuard,
    // Die Auswahl faellt pro Anmeldung anhand der Einstellungen, nicht beim
    // Start: Ein Wechsel im Frontend soll sofort wirken.
    { provide: AUTH_PROVIDER, useExisting: ProviderSelector },
  ],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
