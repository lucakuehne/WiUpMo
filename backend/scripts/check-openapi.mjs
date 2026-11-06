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
import { LdapClient } from '../dist/src/ad/ldap.client.js';
import { SettingsController } from '../dist/src/settings/settings.controller.js';
import { SettingsService } from '../dist/src/settings/settings.service.js';
import { ReportsController } from '../dist/src/reports/reports.controller.js';
import { ReportsService } from '../dist/src/reports/reports.service.js';
import {
  AgentRolloutsController,
  AgentUpdateJobsController,
  ReleasesController,
} from '../dist/src/releases/releases.controller.js';
import { ReleasesService } from '../dist/src/releases/releases.service.js';
import { AgentUpdateController } from '../dist/src/agent-api/agent-update.controller.js';
import { AgentInstallController } from '../dist/src/agent-api/install.controller.js';
import { InstallJobsController } from '../dist/src/install-jobs/install-jobs.controller.js';
import { InstallJobsService } from '../dist/src/install-jobs/install-jobs.service.js';
import { InstallationsController } from '../dist/src/install-jobs/installations.controller.js';
import { AgentRestartController } from '../dist/src/agent-api/restart.controller.js';
import {
  RestartJobsController,
  RestartRequestsController,
} from '../dist/src/restart-jobs/restart-jobs.controller.js';
import { RestartJobsService } from '../dist/src/restart-jobs/restart-jobs.service.js';
import { AgentProblemsController } from '../dist/src/agents/agent-problems.controller.js';
import { AgentProblemsService } from '../dist/src/agents/agent-problems.service.js';
import { PreferencesController } from '../dist/src/preferences/preferences.controller.js';
import { PreferencesService } from '../dist/src/preferences/preferences.service.js';
import { RetentionController } from '../dist/src/retention/retention.controller.js';
import { RetentionService } from '../dist/src/retention/retention.service.js';
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
    SettingsController,
    ReportsController,
    ReleasesController,
    AgentUpdateJobsController,
    AgentRolloutsController,
    AgentUpdateController,
    AgentInstallController,
    AgentRestartController,
    InstallJobsController,
    InstallationsController,
    RestartJobsController,
    RestartRequestsController,
    AgentProblemsController,
    PreferencesController,
    RetentionController,
    HealthController,
  ],
  providers: [
    { provide: CheckinService, useValue: stub },
    { provide: EnrollmentService, useValue: stub },
    { provide: AuthService, useValue: stub },
    { provide: DevicesService, useValue: stub },
    { provide: UpdatesService, useValue: stub },
    { provide: AdSyncService, useValue: stub },
    { provide: LdapClient, useValue: stub },
    { provide: SettingsService, useValue: stub },
    { provide: ReportsService, useValue: stub },
    { provide: ReleasesService, useValue: stub },
    { provide: RetentionService, useValue: stub },
    { provide: InstallJobsService, useValue: stub },
    { provide: RestartJobsService, useValue: stub },
    { provide: AgentProblemsService, useValue: stub },
    { provide: PreferencesService, useValue: stub },
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
