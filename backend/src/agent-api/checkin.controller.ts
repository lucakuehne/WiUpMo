import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isVersionAtLeast } from '../common/agent-version.js';
import { Device } from '../database/entities/index.js';
import { InstallJobsService } from '../install-jobs/install-jobs.service.js';
import { ReleasesService } from '../releases/releases.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  LEGACY_MIN_CHECK_INTERVAL_MINUTES,
  SHORT_INTERVAL_AGENT_VERSION,
} from '../settings/settings.types.js';
import { CheckinService } from './checkin.service.js';
import { CurrentDevice } from './current-device.decorator.js';
import { DeviceAuthGuard } from './device-auth.guard.js';
import { BatchCheckinDto, CheckinResponseDto } from './dto/checkin.dto.js';
import { SnapshotDto } from './dto/snapshot.dto.js';

@ApiTags('agent')
@ApiBearerAuth()
@Controller('api/agent/v1')
@UseGuards(DeviceAuthGuard)
export class CheckinController {
  constructor(
    private readonly checkins: CheckinService,
    private readonly releases: ReleasesService,
    private readonly settings: SettingsService,
    private readonly installJobs: InstallJobsService,
  ) {}

  @Post('checkin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Nimmt einen einzelnen Snapshot entgegen.' })
  async checkin(
    @CurrentDevice() device: Device,
    @Body() snapshot: SnapshotDto,
  ): Promise<CheckinResponseDto> {
    const result = await this.checkins.ingest(device, snapshot);

    return {
      results: [result],
      agentUpdate: await this.releases.claimJob(device.id),
      checkIntervalMinutes: await this.checkInterval(snapshot.agentVersion),
      installRequest: await this.installJobs.claim(device.id, device.agentVersion),
    };
  }

  /**
   * Nachreichung aus der Offline-Warteschlange. Die Snapshots werden der Reihe
   * nach verarbeitet — aelteste zuerst, damit die Zustandsuebergaenge in der
   * richtigen Reihenfolge entstehen. Ein abgelehnter Snapshot haelt die
   * uebrigen nicht auf; der Agent erfaehrt pro Snapshot, was damit passiert ist.
   */
  @Post('checkin/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Nimmt mehrere gepufferte Snapshots entgegen.' })
  async batch(
    @CurrentDevice() device: Device,
    @Body() dto: BatchCheckinDto,
  ): Promise<CheckinResponseDto> {
    const ordered = [...dto.snapshots].sort(
      (a, b) => new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime(),
    );

    const results = [];
    for (const snapshot of ordered) {
      results.push(await this.checkins.ingest(device, snapshot));
    }

    // Der Auftrag wird erst nach der Verarbeitung geholt: Der Agent soll seine
    // gepufferten Meldungen losgeworden sein, bevor er sich selbst ersetzt —
    // ein gescheitertes Update wuerde sonst auch die Warteschlange mitnehmen.
    return {
      results,
      agentUpdate: await this.releases.claimJob(device.id),
      checkIntervalMinutes: await this.checkInterval(ordered.at(-1)?.agentVersion),
      installRequest: await this.installJobs.claim(device.id, device.agentVersion),
    };
  }

  /**
   * Das Melde-Intervall fuer die Antwort, nach der Version des Agents, der
   * fragt — massgeblich ist der juengste Snapshot, denn den hat die laufende
   * Fassung erzeugt. Agents vor 0.8.1 bekommen hoechstens ihre Untergrenze.
   */
  private async checkInterval(agentVersion: string | undefined): Promise<number> {
    const minutes = (await this.settings.getAgent()).checkIntervalMinutes;

    return isVersionAtLeast(agentVersion, SHORT_INTERVAL_AGENT_VERSION)
      ? minutes
      : Math.max(minutes, LEGACY_MIN_CHECK_INTERVAL_MINUTES);
  }
}
