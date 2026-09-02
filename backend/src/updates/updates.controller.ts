import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import { UpdateDevicesDto, UpdateListDto, UpdateQueryDto } from './dto/update-query.dto.js';
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

  @Get(':id/devices')
  @ApiOperation({ summary: 'Betroffene Geraete zu einem Update.' })
  devices(@Param('id', ParseUUIDPipe) id: string): Promise<UpdateDevicesDto> {
    return this.updates.devices(id);
  }
}
