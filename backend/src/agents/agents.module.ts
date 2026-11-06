import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AgentProblemsController } from './agent-problems.controller.js';
import { AgentProblemsService } from './agent-problems.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AgentProblemsController],
  providers: [AgentProblemsService],
})
export class AgentsModule {}
