import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device, DeviceSecret } from '../database/entities/index.js';
import { CheckinController } from './checkin.controller.js';
import { CheckinService } from './checkin.service.js';
import { DeviceAuthGuard } from './device-auth.guard.js';
import { EnrollmentController } from './enrollment.controller.js';
import { EnrollmentService } from './enrollment.service.js';
import { AgentUpdateController } from './agent-update.controller.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { SettingsModule } from '../settings/settings.module.js';

/** Alles, was der Agent anspricht. Das Frontend hat eigene Module. */
@Module({
  imports: [TypeOrmModule.forFeature([Device, DeviceSecret]), SettingsModule, ReleasesModule],
  controllers: [EnrollmentController, CheckinController, AgentUpdateController],
  providers: [EnrollmentService, CheckinService, DeviceAuthGuard],
})
export class AgentApiModule {}
