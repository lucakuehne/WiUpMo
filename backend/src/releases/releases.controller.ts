import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SessionGuard } from '../auth/session.guard.js';
import {
  AgentReleaseDto,
  AgentUpdateJobViewDto,
  CreateUpdateJobsDto,
  CreateUpdateJobsResultDto,
  UploadReleaseDto,
} from './dto/release.dto.js';
import { ReleasesService } from './releases.service.js';

/** Das Binary ist rund 75 MB. Grosszuegig, aber nicht unbegrenzt. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

@ApiTags('agent-releases')
@Controller('api/agent-releases')
@UseGuards(SessionGuard)
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  @ApiOperation({ summary: 'Hinterlegte Agent-Versionen.' })
  list(): Promise<AgentReleaseDto[]> {
    return this.releases.list();
  }

  /**
   * Die Datei geht ueber `diskStorage` in ein temporaeres Verzeichnis, nicht
   * in den Speicher: 75 MB je gleichzeitigem Upload im Arbeitsspeicher wuerden
   * einen Container mit knappem Speicherlimit umbringen.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['version', 'file'],
      properties: {
        version: { type: 'string', example: '0.2.0' },
        notes: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Nimmt ein neues Agent-Binary auf.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: mkdtempSync(`${tmpdir()}/wiupmo-upload-`),
        filename: (_request, _file, callback) => callback(null, `${randomUUID()}.bin`),
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  upload(
    @Body() dto: UploadReleaseDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<AgentReleaseDto> {
    if (!file) {
      throw new BadRequestException('Es wurde keine Datei uebermittelt (Feldname "file").');
    }

    return this.releases.publish(dto.version, dto.notes, file.path);
  }

  @Post(':id/current')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Markiert eine Version als die aktuelle.' })
  async setCurrent(@Param('id', ParseUUIDPipe) id: string): Promise<AgentReleaseDto[]> {
    await this.releases.setCurrent(id);
    return this.releases.list();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Entfernt eine Version samt Datei.' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<AgentReleaseDto[]> {
    await this.releases.remove(id);
    return this.releases.list();
  }
}

@ApiTags('agent-releases')
@Controller('api/agent-update-jobs')
@UseGuards(SessionGuard)
export class AgentUpdateJobsController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  @ApiOperation({ summary: 'Protokoll der Update-Auftraege.' })
  list(@Query('limit') limit?: string): Promise<AgentUpdateJobViewDto[]> {
    const parsed = Number(limit ?? 100);
    return this.releases.jobs(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100);
  }

  /**
   * Ohne Geraeteliste werden alle aktiven Geraete mit abweichender Version
   * beauftragt — der Regelfall beim Ausrollen einer neuen Version.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Legt Update-Auftraege an.' })
  create(@Body() dto: CreateUpdateJobsDto): Promise<CreateUpdateJobsResultDto> {
    return this.releases.createJobs(dto.deviceIds, dto.targetVersion);
  }
}
