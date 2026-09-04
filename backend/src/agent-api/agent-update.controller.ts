import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Device } from '../database/entities/index.js';
import { UpdateResultDto } from '../releases/dto/release.dto.js';
import { ReleasesService } from '../releases/releases.service.js';
import { CurrentDevice } from './current-device.decorator.js';
import { DeviceAuthGuard } from './device-auth.guard.js';

@ApiTags('agent')
@ApiBearerAuth()
@Controller('api/agent/v1')
@UseGuards(DeviceAuthGuard)
export class AgentUpdateController {
  constructor(private readonly releases: ReleasesService) {}

  /**
   * Auslieferung des Binaries.
   *
   * Hinter der Geraete-Authentifizierung, nicht offen: Ein gesperrtes Geraet
   * soll sich auch keine neue Version mehr holen koennen. Die Version steckt
   * im Pfad, damit ein Agent gezielt das Ziel seines Auftrags laedt und nicht
   * versehentlich etwas anderes.
   */
  @Get('binary/:version')
  @ApiOperation({ summary: 'Laedt das Agent-Binary einer Version.' })
  async binary(@Param('version') version: string, @Res() response: Response): Promise<void> {
    const { path, sizeBytes } = await this.releases.openBinary(version);

    response.header('Content-Type', 'application/octet-stream');
    response.header('Content-Length', String(sizeBytes));
    response.header('Content-Disposition', `attachment; filename="wiupmo-agent-${version}.exe"`);
    response.sendFile(path);
  }

  @Post('update-result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rueckmeldung des Agents zum Selbst-Update.' })
  async result(
    @CurrentDevice() device: Device,
    @Body() dto: UpdateResultDto,
  ): Promise<{ ok: true }> {
    await this.releases.reportResult(device.id, dto);
    return { ok: true };
  }
}
