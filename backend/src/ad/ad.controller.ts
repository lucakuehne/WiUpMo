import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import { AdSyncStatus, AdSyncTrigger } from '../database/enums.js';
import { SettingsService } from '../settings/settings.service.js';
import { isAdConfigured } from '../settings/settings.types.js';
import { AdSyncService } from './ad-sync.service.js';
import { AdStatusDto, AdSyncResultDto, AdSyncRunDto, SyncRunsQueryDto } from './dto/ad.dto.js';

@ApiTags('ad')
@Controller('api/ad')
@UseGuards(SessionGuard)
export class AdController {
  constructor(
    private readonly sync: AdSyncService,
    private readonly settings: SettingsService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Konfiguration und letzter Abgleich.' })
  async status(): Promise<AdStatusDto> {
    const config = await this.settings.getAd();
    const runs = await this.sync.recentRuns(1);

    return {
      enabled: isAdConfigured(config),
      url: config.url,
      baseDn: config.baseDn,
      bindDn: config.bindDn,
      bindPasswordSet: config.bindPassword !== '',
      filter: config.filter,
      intervalMinutes: config.intervalMinutes,
      running: this.sync.isRunning,
      lastRun: runs[0] ? toRunDto(runs[0]) : null,
    };
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Startet einen Abgleich von Hand.' })
  run(): Promise<AdSyncResultDto> {
    return this.sync.sync(AdSyncTrigger.Manual);
  }

  @Get('sync-runs')
  @ApiOperation({ summary: 'Protokoll der bisherigen Abgleiche.' })
  async runs(@Query() query: SyncRunsQueryDto): Promise<AdSyncRunDto[]> {
    const rows = await this.sync.recentRuns(query.limit);
    return rows.map(toRunDto);
  }
}

function toRunDto(row: Record<string, unknown>): AdSyncRunDto {
  return {
    id: row.id as string,
    startedAt: toIso(row.started_at) ?? '',
    finishedAt: toIso(row.finished_at),
    trigger: row.trigger as AdSyncTrigger,
    devicesFound: Number(row.devices_found),
    devicesCreated: Number(row.devices_created),
    devicesArchived: Number(row.devices_archived),
    status: row.status as AdSyncStatus,
    error: (row.error as string | null) ?? null,
  };
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
