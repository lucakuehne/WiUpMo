/**
 * Erzeugt das OpenAPI-Dokument gegen das Kompilat — ohne Datenbank.
 *
 * Grund: `SwaggerModule.createDocument` laeuft beim Start des Backends und
 * bricht bei einem DTO, dessen Typ das Swagger-Plugin nicht aufloesen kann, mit
 * „A circular dependency has been detected" ab. Der Container startet dann
 * ueberhaupt nicht — und weil der Uebersetzungslauf davon nichts merkt, faellt
 * es sonst erst im Deployment auf.
 *
 * Aufruf: `pnpm check:openapi` (setzt einen vorangegangenen `pnpm build` voraus).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CheckinController } from '../dist/src/agent-api/checkin.controller.js';
import { EnrollmentController } from '../dist/src/agent-api/enrollment.controller.js';
import { CheckinService } from '../dist/src/agent-api/checkin.service.js';
import { EnrollmentService } from '../dist/src/agent-api/enrollment.service.js';
import { Device, DeviceSecret } from '../dist/src/database/entities/index.js';

const moduleRef = await Test.createTestingModule({
  controllers: [EnrollmentController, CheckinController],
  providers: [
    { provide: CheckinService, useValue: {} },
    { provide: EnrollmentService, useValue: {} },
    // Der DeviceAuthGuard haengt an diesen beiden — fuer die Erzeugung des
    // OpenAPI-Dokuments genuegen Attrappen.
    { provide: getRepositoryToken(Device), useValue: {} },
    { provide: getRepositoryToken(DeviceSecret), useValue: {} },
  ],
}).compile();

const app = moduleRef.createNestApplication();
await app.init();

const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle('check').setVersion('1').build(),
);

const schemas = Object.keys(document.components?.schemas ?? {});
console.log('OpenAPI-Dokument erzeugt. Schemas: ' + schemas.join(', '));
console.log(
  'agentUpdate: ' +
    JSON.stringify(document.components.schemas.CheckinResponseDto.properties.agentUpdate),
);

await app.close();
