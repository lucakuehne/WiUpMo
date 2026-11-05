import { Controller, Get, Param, ParseUUIDPipe, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import {
  UpdateClassificationCountDto,
  UpdateDevicesDto,
  UpdateFilterDto,
  UpdateListDto,
  UpdateListItemDto,
  UpdateQueryDto,
} from './dto/update-query.dto.js';
import { UpdatesService } from './updates.service.js';

@ApiTags('updates')
@Controller('api/updates')
@UseGuards(SessionGuard)
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get()
  @ApiOperation({ summary: 'Update-Katalog mit Betroffenen-Anzahl.' })
  list(@Query() query: UpdateQueryDto): Promise<UpdateListDto> {
    return this.updates.list(query);
  }

  /**
   * Muss vor `:id` stehen — sonst faengt die Detailroute den Pfad ab und der
   * UUID-Filter weist "export" als ungueltige Kennung zurueck.
   */
  @Get('export')
  @ApiOperation({ summary: 'Der gefilterte Katalog als CSV.' })
  async export(@Query() query: UpdateQueryDto, @Res() response: Response): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);

    response
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="updates-${stamp}.csv"`)
      .send(await this.updates.exportCsv(query));
  }

  /** Ebenfalls vor `:id` — aus demselben Grund wie `export`. */
  @Get('classifications')
  @ApiOperation({ summary: 'Updates je Typ unter den uebrigen Filtern, fuer die Navigation.' })
  classifications(@Query() filter: UpdateFilterDto): Promise<UpdateClassificationCountDto[]> {
    return this.updates.classifications(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ein Katalogeintrag mit seinen Zaehlungen.' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UpdateListItemDto> {
    return this.updates.get(id);
  }

  @Get(':id/devices')
  @ApiOperation({ summary: 'Betroffene Geraete zu einem Update.' })
  devices(@Param('id', ParseUUIDPipe) id: string): Promise<UpdateDevicesDto> {
    return this.updates.devices(id);
  }
}
