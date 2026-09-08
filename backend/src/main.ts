import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
// Direkte Abhaengigkeit im package.json, obwohl @nestjs/platform-express das
// Paket ohnehin mitbringt: Unter pnpm ist eine nur transitiv vorhandene
// Abhaengigkeit zur Laufzeit nicht aufloesbar. Der Typ-Import kam durch, der
// Laufzeit-Import brach den Start ab.
import { json, urlencoded } from 'express';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';

/**
 * Obergrenze fuer einen Nachreicheschub aus der Offline-Warteschlange.
 *
 * Die Vorgabe von Express liegt bei 100 kB und reicht hier bei weitem nicht:
 * Ein Geraet, das laenger nicht erreichbar war, schickt bis zu 200 gepufferte
 * Snapshots auf einmal, und der erste davon enthaelt bis zu 90 Tage
 * Update-Historie. Neuere Agents zerlegen das selbst in kleinere Schuebe — die
 * grosszuegige Grenze gilt den bereits verteilten, die das noch nicht tun.
 */
const CHECKIN_BODY_LIMIT = '32mb';

/**
 * Fuer alles andere bleibt es eng. Die Einstellungen, die Anmeldung und die
 * Auftraege sind Kilobyte-Sachen; die einzige grosse Nutzlast ist der Upload
 * eines Agent-Binaries, und der laeuft als multipart an dieser Stelle vorbei.
 */
const DEFAULT_BODY_LIMIT = '1mb';

async function bootstrap(): Promise<void> {
  // Ohne die eingebauten Parser: Sie liessen sich nur global einstellen, und
  // die 32 MB sollen ausschliesslich fuer den Check-in gelten.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const logger = new Logger('Bootstrap');

  // Reihenfolge entscheidet: body-parser ueberspringt eine Anfrage, deren
  // Koerper bereits gelesen wurde. Die enge Grenze darf deshalb erst danach
  // kommen. Der Pfad passt als Praefix auch auf /checkin/batch.
  app.use('/api/agent/v1/checkin', json({ limit: CHECKIN_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));

  // Das Sitzungstoken kommt als HttpOnly-Cookie; ohne diesen Leser ist
  // request.cookies undefiniert und jede Anmeldung liefe ins Leere.
  app.use(cookieParser());

  app.useGlobalFilters(new AllExceptionsFilter());

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
