import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Device } from '../database/entities/index.js';
import { InstallResultDto } from '../install-jobs/dto/install-job.dto.js';
import { InstallJobsService } from '../install-jobs/install-jobs.service.js';
import { CurrentDevice } from './current-device.decorator.js';
import { DeviceAuthGuard } from './device-auth.guard.js';

@ApiTags('agent')
@ApiBearerAuth()
@Controller('api/agent/v1')
@UseGuards(DeviceAuthGuard)
export class AgentInstallController {
  constructor(private readonly jobs: InstallJobsService) {}

  @Post('install-result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rueckmeldung des Agents zu einem Installationsauftrag.' })
  async result(@CurrentDevice() device: Device, @Body() dto: InstallResultDto): Promise<{ ok: true }> {
    await this.jobs.reportResult(device.id, dto);
    return { ok: true };
  }
}
