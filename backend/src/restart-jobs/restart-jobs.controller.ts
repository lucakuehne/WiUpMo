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
  CreateRestartJobsDto,
  CreateRestartJobsResultDto,
  RestartJobViewDto,
  RestartRequestListDto,
  RestartRequestQueryDto,
} from './dto/restart-job.dto.js';
import { RestartJobsService } from './restart-jobs.service.js';

@ApiTags('restarts')
@Controller('api/restart-jobs')
@UseGuards(SessionGuard)
export class RestartJobsController {
  constructor(private readonly restarts: RestartJobsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fordert fuer die gewaehlten Geraete einen Neustart an.' })
  create(
    @Body() dto: CreateRestartJobsDto,
    @Req() request: RequestWithSession,
  ): Promise<CreateRestartJobsResultDto> {
    return this.restarts.create(dto, request.session!.username);
  }

  @Get()
  @ApiOperation({ summary: 'Neustart-Auftraege eines Geraets, neueste zuerst.' })
  list(
    @Query('deviceId', ParseUUIDPipe) deviceId: string,
    @Query('limit') limit?: string,
  ): Promise<RestartJobViewDto[]> {
    const parsed = Number(limit ?? 50);
    const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 50;
    return this.restarts.deviceJobs(deviceId, capped);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bricht einen Neustart ab, solange er nicht eingeleitet ist.' })
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    await this.restarts.cancelJob(id);
    return { ok: true };
  }
}

/** Neustart-Anfragen: was in einem Zug fuer mehrere Geraete angefordert wurde. */
@ApiTags('restarts')
@Controller('api/restart-requests')
@UseGuards(SessionGuard)
export class RestartRequestsController {
  constructor(private readonly restarts: RestartJobsService) {}

  @Get()
  @ApiOperation({ summary: 'Neustart-Anfragen, neueste zuerst, mit Fortschritt.' })
  list(@Query() query: RestartRequestQueryDto): Promise<RestartRequestListDto> {
    return this.restarts.listRequests(query.page, query.limit);
  }

  @Get(':id/jobs')
  @ApiOperation({ summary: 'Die Auftraege einer Anfrage, ein Geraet je Zeile.' })
  jobs(@Param('id', ParseUUIDPipe) id: string): Promise<RestartJobViewDto[]> {
    return this.restarts.requestJobs(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bricht alle noch nicht eingeleiteten Neustarts einer Anfrage ab.' })
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<{ cancelled: number }> {
    return { cancelled: await this.restarts.cancelRequest(id) };
  }
}
