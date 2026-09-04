import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsCoreModule } from '../settings/settings-core.module.js';
import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';

@Module({
  imports: [ScheduleModule.forRoot(), AuthModule, SettingsCoreModule],
  controllers: [RetentionController],
  providers: [RetentionService],
})
export class RetentionModule {}
