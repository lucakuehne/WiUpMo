import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AdController } from './ad.controller.js';
import { AdSchedulerService } from './ad-scheduler.service.js';
import { AdSyncService } from './ad-sync.service.js';
import { LdapClient } from './ldap.client.js';

@Module({
  imports: [ScheduleModule.forRoot(), AuthModule, SettingsModule],
  controllers: [AdController],
  providers: [LdapClient, AdSyncService, AdSchedulerService],
  exports: [AdSyncService],
})
export class AdModule {}
