import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SettingsCoreModule } from './settings-core.module.js';
import { SettingsController } from './settings.controller.js';

@Module({
  imports: [SettingsCoreModule, AuthModule],
  controllers: [SettingsController],
  // Weiterreichen, damit die uebrigen Module weiterhin dieses Modul einbinden
  // koennen und nicht wissen muessen, dass die Ablage daneben liegt.
  exports: [SettingsCoreModule],
})
export class SettingsModule {}
