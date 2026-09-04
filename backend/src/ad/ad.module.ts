import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AdController } from './ad.controller.js';
import { AdSchedulerService } from './ad-scheduler.service.js';
import { AdSyncService } from './ad-sync.service.js';
import { LdapModule } from './ldap.module.js';

@Module({
  imports: [ScheduleModule.forRoot(), AuthModule, SettingsModule, LdapModule],
  controllers: [AdController],
  providers: [AdSyncService, AdSchedulerService],
  exports: [AdSyncService],
})
export class AdModule {}
