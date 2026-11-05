import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsCoreModule } from '../settings/settings-core.module.js';
import { InstallJobsController } from './install-jobs.controller.js';
import { InstallJobsService } from './install-jobs.service.js';
import { InstallationsController } from './installations.controller.js';

@Module({
  imports: [AuthModule, SettingsCoreModule],
  controllers: [InstallJobsController, InstallationsController],
  providers: [InstallJobsService],
  // Die Agent-Schnittstelle liefert die Auftraege aus und nimmt die Ergebnisse an.
  exports: [InstallJobsService],
})
export class InstallJobsModule {}
