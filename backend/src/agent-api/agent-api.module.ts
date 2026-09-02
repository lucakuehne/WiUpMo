import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device, DeviceSecret } from '../database/entities/index.js';
import { CheckinController } from './checkin.controller.js';
import { CheckinService } from './checkin.service.js';
import { DeviceAuthGuard } from './device-auth.guard.js';
import { EnrollmentController } from './enrollment.controller.js';
import { EnrollmentService } from './enrollment.service.js';

/** Alles, was der Agent anspricht. Das Frontend hat eigene Module. */
@Module({
  imports: [TypeOrmModule.forFeature([Device, DeviceSecret])],
  controllers: [EnrollmentController, CheckinController],
  providers: [EnrollmentService, CheckinService, DeviceAuthGuard],
})
export class AgentApiModule {}
