import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import {
  AdSettingsDto,
  AdSettingsViewDto,
  AgentSettingsViewDto,
  AuthSettingsDto,
  AuthSettingsViewDto,
  EnrollmentTokenDto,
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
    const [agent, ad, auth, thresholds, retention] = await Promise.all([
      this.settings.getAgent(),
      this.settings.getAd(),
      this.settings.getAuth(),
      this.settings.getThresholds(),
      this.settings.getRetention(),
    ]);

    return { agent, ad: toAdView(ad), auth, thresholds, retention };
  }

  @Put('auth')
  @ApiOperation({ summary: 'Aendert den Anmeldeweg.' })
  updateAuth(@Body() dto: AuthSettingsDto): Promise<AuthSettingsViewDto> {
    return this.settings.updateAuth(dto);
  }

  /**
   * Setzt das Enrollment-Token. Ohne Angabe wird eines erzeugt.
   *
   * Bereits registrierte Geraete sind davon nicht betroffen — sie arbeiten mit
   * ihrem eigenen Secret weiter. Betroffen sind nur Neuinstallationen.
   */
  @Put('agent/enrollment-token')
  @ApiOperation({ summary: 'Setzt oder erneuert das Enrollment-Token.' })
  setEnrollmentToken(@Body() dto: EnrollmentTokenDto): Promise<AgentSettingsViewDto> {
    return this.settings.setEnrollmentToken(dto.token);
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
