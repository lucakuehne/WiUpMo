import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CookieOptions, Response } from 'express';
import { AuthenticatedUser } from './auth-provider.js';
import { AuthService, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './auth.service.js';
import { AuthStatusDto, LoginDto, SessionUserDto, SetupDto } from './dto/auth.dto.js';
import { RequestWithSession, SessionGuard } from './session.guard.js';

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Der erste Aufruf des Frontends. Er beantwortet beide Fragen auf einmal:
   * Muss eingerichtet werden, und ist bereits jemand angemeldet? Ohne das
   * muesste das Frontend raten oder zwei Anfragen stellen.
   */
  @Get('status')
  @ApiOperation({ summary: 'Einrichtungs- und Anmeldezustand.' })
  async status(@Req() request: RequestWithSession): Promise<AuthStatusDto> {
    const token: unknown = request.cookies?.[SESSION_COOKIE];
    const session = typeof token === 'string' ? await this.auth.verifyToken(token) : null;

    return {
      setupRequired: await this.auth.isSetupRequired(),
      authenticated: session !== null,
      username: session?.username ?? null,
      provider: await this.auth.providerName(),
    };
  }

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Legt den ersten Benutzer an. Nur gueltig, solange keiner existiert.' })
  async setup(
    @Body() dto: SetupDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionUserDto> {
    const user = await this.auth.setup(dto);
    await this.startSession(user, response);
    return user;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Meldet einen Benutzer an und setzt das Sitzungscookie.' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionUserDto> {
    const user = await this.auth.login(dto.username, dto.password);
    await this.startSession(user, response);
    return user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Beendet die Sitzung.' })
  logout(@Res({ passthrough: true }) response: Response): { ok: true } {
    response.clearCookie(SESSION_COOKIE, cookieOptions(0));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Der angemeldete Benutzer.' })
  me(@Req() request: RequestWithSession): SessionUserDto {
    return { id: request.session!.sub, username: request.session!.username };
  }

  private async startSession(user: AuthenticatedUser, response: Response): Promise<void> {
    const token = await this.auth.issueToken(user);
    response.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_MAX_AGE_SECONDS * 1000));
  }
}

function cookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    // 'lax' statt 'strict': Bei 'strict' waere das Cookie nach dem Klick auf
    // einen Link aus einer E-Mail oder einem Chat nicht dabei, und der Benutzer
    // landete auf der Anmeldeseite, obwohl er angemeldet ist.
    sameSite: 'lax',
    // Nur ueber HTTPS uebertragen, sobald das Backend hinter TLS steht. Im
    // internen Testbetrieb ueber http waere das Cookie sonst nie gesetzt.
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: maxAgeMs,
  };
}
