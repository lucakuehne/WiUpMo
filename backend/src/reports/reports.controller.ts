import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import {
  ComplianceDeviceDto,
  FailureGroupDto,
  MissingAgentDto,
  PatchAgeReportDto,
  StaleAgentDto,
  SummaryDto,
  TimeToPatchDto,
  TrendPointDto,
  TrendQueryDto,
  UpdateSourcesReportDto,
} from './dto/reports.dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@Controller('api/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Kennzahlen fuer das Dashboard.' })
  summary(): Promise<SummaryDto> {
    return this.reports.summary();
  }

  @Get('compliance')
  @ApiOperation({ summary: 'Geraete mit zu lange offenen Sicherheitsupdates.' })
  compliance(): Promise<ComplianceDeviceDto[]> {
    return this.reports.compliance();
  }

  @Get('patch-age')
  @ApiOperation({ summary: 'Verteilung des Patch-Alters und der OS-Builds.' })
  patchAge(): Promise<PatchAgeReportDto> {
    return this.reports.patchAge();
  }

  @Get('update-sources')
  @ApiOperation({ summary: 'Verteilung der Update-Quellen und Quellenwechsel.' })
  updateSources(): Promise<UpdateSourcesReportDto> {
    return this.reports.updateSources();
  }

  @Get('stale-agents')
  @ApiOperation({ summary: 'Geraete, die sich nicht mehr melden.' })
  staleAgents(): Promise<StaleAgentDto[]> {
    return this.reports.staleAgents();
  }

  @Get('missing-agents')
  @ApiOperation({ summary: 'Im AD bekannte Geraete ohne Agent.' })
  missingAgents(): Promise<MissingAgentDto[]> {
    return this.reports.missingAgents();
  }

  @Get('time-to-patch')
  @ApiOperation({ summary: 'Median-Tage von "verfuegbar" bis "installiert" je Einstufung.' })
  timeToPatch(): Promise<TimeToPatchDto[]> {
    return this.reports.timeToPatch();
  }

  @Get('failures')
  @ApiOperation({ summary: 'Wiederholt gescheiterte Installationen, nach Fehlercode gruppiert.' })
  failures(): Promise<FailureGroupDto[]> {
    return this.reports.failures();
  }

  @Get('trend')
  @ApiOperation({ summary: 'Verlauf der offenen Updates ueber die Zeit.' })
  trend(@Query() query: TrendQueryDto): Promise<TrendPointDto[]> {
    return this.reports.trend(query.days);
  }
}
