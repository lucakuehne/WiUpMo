import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestWithSession, SessionGuard } from '../auth/session.guard.js';
import {
  CreateInstallJobsDto,
  CreateInstallJobsResultDto,
  InstallJobViewDto,
  InstallPreviewDto,
  InstallPreviewRequestDto,
} from './dto/install-job.dto.js';
import { InstallJobsService } from './install-jobs.service.js';

@ApiTags('install-jobs')
@Controller('api/install-jobs')
@UseGuards(SessionGuard)
export class InstallJobsController {
  constructor(private readonly jobs: InstallJobsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Legt Installationsauftraege fuer offene Updates an.' })
  create(
    @Body() dto: CreateInstallJobsDto,
    @Req() request: RequestWithSession,
  ): Promise<CreateInstallJobsResultDto> {
    return this.jobs.create(dto, request.session!.username);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Offene Updates je Update-Typ auf den gewaehlten Geraeten.' })
  preview(@Body() dto: InstallPreviewRequestDto): Promise<InstallPreviewDto> {
    return this.jobs.preview(dto.deviceIds);
  }

  @Get()
  @ApiOperation({ summary: 'Protokoll der Installationsauftraege, wahlweise eines Geraets.' })
  list(
    @Query('limit') limit?: string,
    @Query('deviceId', new ParseUUIDPipe({ optional: true })) deviceId?: string,
  ): Promise<InstallJobViewDto[]> {
    const parsed = Number(limit ?? 50);
    const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 50;
    return this.jobs.list(capped, { deviceId });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bricht einen Auftrag ab, solange er nicht laeuft.' })
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    await this.jobs.cancel(id);
    return { ok: true };
  }
}
