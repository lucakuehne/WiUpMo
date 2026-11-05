import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import {
  InstallationCancelResultDto,
  InstallationListDto,
  InstallationQueryDto,
  InstallJobViewDto,
} from './dto/install-job.dto.js';
import { InstallJobsService } from './install-jobs.service.js';

/**
 * Installationen: was in einem Zug fuer mehrere Geraete angelegt wurde. Die
 * Auftraege je Geraet stehen weiterhin unter `api/install-jobs`.
 */
@ApiTags('install-jobs')
@Controller('api/installations')
@UseGuards(SessionGuard)
export class InstallationsController {
  constructor(private readonly installs: InstallJobsService) {}

  @Get()
  @ApiOperation({ summary: 'Installationen, neueste zuerst, mit Fortschritt.' })
  list(@Query() query: InstallationQueryDto): Promise<InstallationListDto> {
    return this.installs.listInstallations(query.page, query.limit);
  }

  @Get(':id/jobs')
  @ApiOperation({ summary: 'Die Auftraege einer Installation, ein Geraet je Zeile.' })
  jobs(@Param('id', ParseUUIDPipe) id: string): Promise<InstallJobViewDto[]> {
    return this.installs.installationJobs(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bricht alle noch nicht laufenden Auftraege einer Installation ab.' })
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<InstallationCancelResultDto> {
    return this.installs.cancelInstallation(id);
  }
}
