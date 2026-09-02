import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Das Sitzungstoken kommt als HttpOnly-Cookie; ohne diesen Leser ist
  // request.cookies undefiniert und jede Anmeldung liefe ins Leere.
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      // Felder, die im DTO nicht deklariert sind, fliegen raus statt
      // durchgereicht zu werden.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Windows Update Monitoring')
    .setDescription('Agent- und Frontend-Schnittstelle.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  /**
   * Der Vertrag wird bei jedem Start nach shared/ geschrieben. Damit ist die
   * OpenAPI-Datei immer der Stand des Codes und muss nicht von Hand gepflegt
   * werden — der Agent und spaeter das Frontend haengen daran.
   */
  if (process.env.NODE_ENV === 'development') {
    // import.meta.dirname statt __dirname — unter ESM gibt es __dirname nicht.
    const target = join(import.meta.dirname, '..', '..', '..', 'shared', 'openapi.json');
    try {
      writeFileSync(target, JSON.stringify(document, null, 2), 'utf8');
      logger.log(`OpenAPI-Vertrag geschrieben: ${target}`);
    } catch (error) {
      logger.warn(`OpenAPI-Vertrag konnte nicht geschrieben werden: ${String(error)}`);
    }
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`Backend laeuft auf Port ${port}. Dokumentation unter /api/docs.`);
}

void bootstrap();
