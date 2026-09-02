import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting, User } from '../database/entities/index.js';
import { AUTH_PROVIDER } from './auth-provider.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LocalAuthProvider } from './local-auth.provider.js';
import { SessionGuard } from './session.guard.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Setting]),
    // Ohne globales Geheimnis: es wird pro Aufruf aus den Einstellungen bzw.
    // aus JWT_SECRET geholt, siehe AuthService.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LocalAuthProvider,
    SessionGuard,
    // Phase 7 tauscht hier auf eine Fabrik um, die nach `auth_provider` in den
    // Einstellungen zwischen lokal und LDAP entscheidet.
    { provide: AUTH_PROVIDER, useExisting: LocalAuthProvider },
  ],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
