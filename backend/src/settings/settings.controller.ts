import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import {
  AdSettingsDto,
  AdSettingsViewDto,
  RetentionSettingsDto,
  RetentionSettingsViewDto,
  SettingsViewDto,
  ThresholdSettingsDto,
  ThresholdSettingsViewDto,
} from './dto/settings.dto.js';
import { SettingsService } from './settings.service.js';
import { AdSettings, isAdConfigured } from './settings.types.js';

@ApiTags('settings')
@Controller('api/settings')
@UseGuards(SessionGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Alle Laufzeiteinstellungen.' })
  async read(): Promise<SettingsViewDto> {
    const [ad, thresholds, retention] = await Promise.all([
      this.settings.getAd(),
      this.settings.getThresholds(),
      this.settings.getRetention(),
    ]);

    return { ad: toAdView(ad), thresholds, retention };
  }

  /**
   * Teilweise Aktualisierung: Nicht gesendete Felder bleiben, wie sie sind.
   * Das ist hier keine Bequemlichkeit — das Bind-Passwort wird nie
   * ausgeliefert, koennte also gar nicht vollstaendig zurueckgeschickt werden.
   */
  @Put('ad')
  @ApiOperation({ summary: 'Aendert die AD-Anbindung.' })
  async updateAd(@Body() dto: AdSettingsDto): Promise<AdSettingsViewDto> {
    return toAdView(await this.settings.updateAd(dto));
  }

  @Put('thresholds')
  @ApiOperation({ summary: 'Aendert die Schwellwerte der Auswertungen.' })
  updateThresholds(@Body() dto: ThresholdSettingsDto): Promise<ThresholdSettingsViewDto> {
    return this.settings.updateThresholds(dto);
  }

  @Put('retention')
  @ApiOperation({ summary: 'Aendert die Aufbewahrungsfristen.' })
  updateRetention(@Body() dto: RetentionSettingsDto): Promise<RetentionSettingsViewDto> {
    return this.settings.updateRetention(dto);
  }
}

function toAdView(ad: AdSettings): AdSettingsViewDto {
  const { bindPassword, ...rest } = ad;
  return { ...rest, bindPasswordSet: bindPassword !== '', configured: isAdConfigured(ad) };
}
