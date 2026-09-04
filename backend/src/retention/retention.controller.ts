import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import { RetentionService } from './retention.service.js';

export class RetentionResultDto {
  eventsDeleted: number;
  checkinsDeleted: number;
  eventDays: number;
  checkinDays: number;
}

@ApiTags('settings')
@Controller('api/maintenance')
@UseGuards(SessionGuard)
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  /**
   * Von Hand ausloesbar, damit sich eine geaenderte Aufbewahrungsfrist sofort
   * auswirkt und nicht erst in der naechsten Nacht — und damit man sieht, was
   * sie tatsaechlich loescht, bevor man sie stehen laesst.
   */
  @Post('retention')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fuehrt das Aufraeumen sofort aus.' })
  run(): Promise<RetentionResultDto> {
    return this.retention.run();
  }
}
