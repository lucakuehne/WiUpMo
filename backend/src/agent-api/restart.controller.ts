import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Device } from '../database/entities/index.js';
import { RestartResultDto } from '../restart-jobs/dto/restart-job.dto.js';
import { RestartJobsService } from '../restart-jobs/restart-jobs.service.js';
import { CurrentDevice } from './current-device.decorator.js';
import { DeviceAuthGuard } from './device-auth.guard.js';

@ApiTags('agent')
@ApiBearerAuth()
@Controller('api/agent/v1')
@UseGuards(DeviceAuthGuard)
export class AgentRestartController {
  constructor(private readonly restarts: RestartJobsService) {}

  @Post('restart-result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rueckmeldung des Agents zu einem Neustart-Auftrag.' })
  async result(@CurrentDevice() device: Device, @Body() dto: RestartResultDto): Promise<{ ok: true }> {
    await this.restarts.reportResult(device.id, dto);
    return { ok: true };
  }
}
