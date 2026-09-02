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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import { DevicesService } from './devices.service.js';
import { ArchiveDeviceDto, DeviceDetailDto, TimelineDto, TimelineQueryDto } from './dto/device-detail.dto.js';
import { DeviceListDto, DeviceQueryDto } from './dto/device-query.dto.js';

@ApiTags('devices')
@Controller('api/devices')
@UseGuards(SessionGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({ summary: 'Geraeteliste mit Filter, Sortierung und Seiten.' })
  list(@Query() query: DeviceQueryDto): Promise<DeviceListDto> {
    return this.devices.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Gerät mit aktuellen Update-Zustaenden und Check-in-Historie.' })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<DeviceDetailDto> {
    return this.devices.detail(id);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archiviert ein Geraet. Daten bleiben erhalten.' })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveDeviceDto,
  ): Promise<DeviceDetailDto> {
    return this.devices.setArchived(id, true, dto.reason ?? 'Von Hand archiviert.');
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hebt die Archivierung auf.' })
  restore(@Param('id', ParseUUIDPipe) id: string): Promise<DeviceDetailDto> {
    return this.devices.setArchived(id, false, null);
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Zeitreihe der Update-Ereignisse eines Geraets.' })
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TimelineQueryDto,
  ): Promise<TimelineDto> {
    return this.devices.timeline(id, query);
  }
}
