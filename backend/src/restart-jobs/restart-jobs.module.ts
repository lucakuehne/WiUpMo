import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsCoreModule } from '../settings/settings-core.module.js';
import { RestartJobsController, RestartRequestsController } from './restart-jobs.controller.js';
import { RestartJobsService } from './restart-jobs.service.js';

@Module({
  imports: [AuthModule, SettingsCoreModule],
  controllers: [RestartJobsController, RestartRequestsController],
  providers: [RestartJobsService],
  // Die Agent-Schnittstelle liefert die Auftraege aus und nimmt die Rueckmeldungen an.
  exports: [RestartJobsService],
})
export class RestartJobsModule {}
