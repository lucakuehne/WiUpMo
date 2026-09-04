import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from '../database/entities/index.js';
import { SettingsService } from './settings.service.js';

/**
 * Nur die Ablage, ohne Controller.
 *
 * Die Trennung ist keine Kosmetik: Das Auth-Modul braucht die Einstellungen
 * (welcher Anmeldeweg gilt), und der Einstellungs-Controller braucht den
 * SessionGuard aus dem Auth-Modul. Ein gemeinsames Modul haette die beiden in
 * einen Zirkel gebracht, den Nest nur mit `forwardRef` aufloesen kann — und
 * das ist eine Krücke, keine Struktur.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Setting])],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsCoreModule {}
