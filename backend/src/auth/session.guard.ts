import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthService, SESSION_COOKIE, SessionPayload } from './auth.service.js';

export interface RequestWithSession extends Request {
  session?: SessionPayload;
}

/**
 * Schuetzt alle Frontend-Endpunkte. Das Token kommt aus einem HttpOnly-Cookie,
 * nicht aus einem Header: so kommt kein Skript im Browser daran, und das
 * Frontend muss es nirgends zwischenspeichern.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();

    const token: unknown = request.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException('Nicht angemeldet.');
    }

    const payload = await this.auth.verifyToken(token);
    if (!payload) {
      throw new UnauthorizedException('Die Sitzung ist abgelaufen.');
    }

    request.session = payload;
    return true;
  }
}
