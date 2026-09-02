import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Setting } from '../database/entities/index.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Setting]), AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
