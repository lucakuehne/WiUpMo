import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentApiModule } from './agent-api/agent-api.module.js';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './config/env.validation.js';
import { dataSourceOptions } from './database/data-source.js';
import { DevicesModule } from './devices/devices.module.js';
import { HealthController } from './health/health.controller.js';
import { UpdatesModule } from './updates/updates.module.js';

/**
 * Das gebaute Frontend liegt im Container unter /app/public. In der Entwicklung
 * gibt es das Verzeichnis nicht — dort laeuft der Vite-Server und leitet seine
 * API-Aufrufe hierher weiter. Deshalb die Pruefung: ohne sie wuerde
 * ServeStaticModule jede unbekannte Route abfangen und statt einer sauberen
 * 404 einen Fehler ueber das fehlende Verzeichnis liefern.
 */
const frontendRoot = join(import.meta.dirname, '..', '..', 'public');
const frontendAvailable = existsSync(frontendRoot);

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Beim Start scheitern, nicht beim ersten Zugriff auf einen fehlenden Wert.
      expandVariables: false,
    }),
    TypeOrmModule.forRoot(dataSourceOptions),
    AgentApiModule,
    AuthModule,
    DevicesModule,
    UpdatesModule,
    ...(frontendAvailable
      ? [
          ServeStaticModule.forRoot({
            rootPath: frontendRoot,
            // Die API darf nicht von der Einzelseiten-Auslieferung verschluckt
            // werden — ein unbekannter /api-Pfad soll 404 sein, nicht index.html.
            exclude: ['/api/{*path}'],
          }),
        ]
      : []),
  ],
  controllers: [HealthController],
})
export class AppModule {}
