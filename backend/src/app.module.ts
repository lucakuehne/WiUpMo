import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentApiModule } from './agent-api/agent-api.module.js';
import { validateEnv } from './config/env.validation.js';
import { dataSourceOptions } from './database/data-source.js';
import { HealthController } from './health/health.controller.js';

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
  ],
  controllers: [HealthController],
})
export class AppModule {}
