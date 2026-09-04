import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AgentUpdateJobsController, ReleasesController } from './releases.controller.js';
import { ReleasesService } from './releases.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ReleasesController, AgentUpdateJobsController],
  providers: [ReleasesService],
  // Die Agent-Schnittstelle braucht den Dienst fuer Binary-Auslieferung,
  // Auftragszustellung und Rueckmeldung.
  exports: [ReleasesService],
})
export class ReleasesModule {}
