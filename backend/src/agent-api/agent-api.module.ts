import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device, DeviceSecret } from '../database/entities/index.js';
import { CheckinController } from './checkin.controller.js';
import { CheckinService } from './checkin.service.js';
import { DeviceAuthGuard } from './device-auth.guard.js';
import { EnrollmentController } from './enrollment.controller.js';
import { EnrollmentService } from './enrollment.service.js';
import { AgentUpdateController } from './agent-update.controller.js';
import { AgentInstallController } from './install.controller.js';
import { AgentRestartController } from './restart.controller.js';
import { InstallJobsModule } from '../install-jobs/install-jobs.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { RestartJobsModule } from '../restart-jobs/restart-jobs.module.js';
import { SettingsModule } from '../settings/settings.module.js';

/** Alles, was der Agent anspricht. Das Frontend hat eigene Module. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceSecret]),
    SettingsModule,
    ReleasesModule,
    InstallJobsModule,
    RestartJobsModule,
  ],
  controllers: [
    EnrollmentController,
    CheckinController,
    AgentUpdateController,
    AgentInstallController,
    AgentRestartController,
  ],
  providers: [EnrollmentService, CheckinService, DeviceAuthGuard],
})
export class AgentApiModule {}
