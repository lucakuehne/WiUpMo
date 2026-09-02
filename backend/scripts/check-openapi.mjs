/**
 * Erzeugt das OpenAPI-Dokument gegen das Kompilat — ohne Datenbank.
 *
 * Grund: `SwaggerModule.createDocument` laeuft beim Start des Backends und
 * bricht bei einem DTO, dessen Typ das Swagger-Plugin nicht aufloesen kann, mit
 * „A circular dependency has been detected" ab. Der Container startet dann
 * ueberhaupt nicht — und weil der Uebersetzungslauf davon nichts merkt, faellt
 * es sonst erst im Deployment auf.
 *
 * Die Dienste sind Attrappen: geprueft wird die Schema-Erzeugung aus den DTOs,
 * nicht das Verhalten.
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
import { AuthController } from '../dist/src/auth/auth.controller.js';
import { AuthService } from '../dist/src/auth/auth.service.js';
import { SessionGuard } from '../dist/src/auth/session.guard.js';
import { DevicesController } from '../dist/src/devices/devices.controller.js';
import { DevicesService } from '../dist/src/devices/devices.service.js';
import { UpdatesController } from '../dist/src/updates/updates.controller.js';
import { UpdatesService } from '../dist/src/updates/updates.service.js';
import { AdController } from '../dist/src/ad/ad.controller.js';
import { AdSyncService } from '../dist/src/ad/ad-sync.service.js';
import { AdConfigService } from '../dist/src/ad/ad-config.js';
import { HealthController } from '../dist/src/health/health.controller.js';
import { Device, DeviceSecret } from '../dist/src/database/entities/index.js';
import { getDataSourceToken } from '@nestjs/typeorm';

const stub = {};

const moduleRef = await Test.createTestingModule({
  controllers: [
    EnrollmentController,
    CheckinController,
    AuthController,
    DevicesController,
    UpdatesController,
    AdController,
    HealthController,
  ],
  providers: [
    { provide: CheckinService, useValue: stub },
    { provide: EnrollmentService, useValue: stub },
    { provide: AuthService, useValue: stub },
    { provide: DevicesService, useValue: stub },
    { provide: UpdatesService, useValue: stub },
    { provide: AdSyncService, useValue: stub },
    { provide: AdConfigService, useValue: stub },
    // Guards werden von Nest ueber den Container erzeugt; ohne Attrappe
    // scheiterte schon das Zusammenbauen des Moduls.
    { provide: SessionGuard, useValue: { canActivate: () => true } },
    { provide: getRepositoryToken(Device), useValue: stub },
    { provide: getRepositoryToken(DeviceSecret), useValue: stub },
    { provide: getDataSourceToken(), useValue: stub },
  ],
}).compile();

const app = moduleRef.createNestApplication();
await app.init();

const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle('check').setVersion('1').build(),
);

const schemas = Object.keys(document.components?.schemas ?? {});
const paths = Object.keys(document.paths ?? {});

console.log(`OpenAPI-Dokument erzeugt: ${paths.length} Pfade, ${schemas.length} Schemas.`);
console.log('Pfade:   ' + paths.join(', '));
console.log('Schemas: ' + schemas.join(', '));

await app.close();
