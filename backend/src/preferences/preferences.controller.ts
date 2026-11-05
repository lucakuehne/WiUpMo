import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestWithSession, SessionGuard } from '../auth/session.guard.js';
import { PreferencesDto, PreferencesViewDto } from './preferences.dto.js';
import { PreferencesService } from './preferences.service.js';

/** Immer die des angemeldeten Benutzers; fremde lassen sich weder lesen noch setzen. */
@ApiTags('preferences')
@Controller('api/preferences')
@UseGuards(SessionGuard)
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  @ApiOperation({ summary: 'Gespeicherte Auswahlen des angemeldeten Benutzers.' })
  get(@Req() request: RequestWithSession): Promise<PreferencesViewDto> {
    return this.preferences.get(request.session!.username);
  }

  @Put()
  @ApiOperation({ summary: 'Speichert Auswahlen des angemeldeten Benutzers.' })
  update(@Req() request: RequestWithSession, @Body() dto: PreferencesDto): Promise<PreferencesViewDto> {
    return this.preferences.update(request.session!.username, dto);
  }
}
