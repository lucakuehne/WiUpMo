import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard.js';
import { AgentProblemDto, AgentProblemQueryDto } from './agent-problems.dto.js';
import { AgentProblemsService } from './agent-problems.service.js';

@ApiTags('agents')
@Controller('api/agent-problems')
@UseGuards(SessionGuard)
export class AgentProblemsController {
  constructor(private readonly problems: AgentProblemsService) {}

  @Get()
  @ApiOperation({ summary: 'Warnungen und Fehler der Agents, nach Meldung zusammengefasst.' })
  list(@Query() query: AgentProblemQueryDto): Promise<AgentProblemDto[]> {
    return this.problems.list(query.days);
  }
}
