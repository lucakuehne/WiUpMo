/**
 * **Beziehungsfelder immer als `Relation<T>` deklarieren, nie als `T`.**
 *
 * `emitDecoratorMetadata` schreibt zu jeder Eigenschaft eine
 * `design:type`-Angabe — und die ist eine *direkte* Referenz auf die Klasse,
 * nicht die verzoegerte `() => Klasse` der Beziehungsdekoratoren. Bei zwei
 * Entities, die einander importieren (`Device` ↔ `DeviceSecret`), laeuft diese
 * Referenz unter ESM in die temporale Totzone: das zuerst geladene Modul ist
 * beim Auswerten des Dekorators noch nicht fertig initialisiert.
 *
 * Der Fehler lautet dann `Cannot access 'Device' before initialization` und
 * tritt erst zur Laufzeit auf — der Uebersetzungslauf ist ahnungslos.
 *
 * `Relation<T>` ist ein Alias auf `T` und existiert allein dafuer: der Typ
 * verschwindet beim Uebersetzen, `design:type` wird zu `Object`, der Zirkel
 * ist entschaerft. Die Typpruefung bleibt vollstaendig erhalten.
 */

import { AdSyncRun } from './ad-sync-run.entity.js';
import { AgentRelease } from './agent-release.entity.js';
import { AgentUpdateJob } from './agent-update-job.entity.js';
import { Device } from './device.entity.js';
import { DeviceCheckin } from './device-checkin.entity.js';
import { DeviceSecret } from './device-secret.entity.js';
import { DeviceUpdateEvent } from './device-update-event.entity.js';
import { DeviceUpdateState } from './device-update-state.entity.js';
import { Setting } from './setting.entity.js';
import { Update } from './update.entity.js';
import { User } from './user.entity.js';

export {
  AdSyncRun,
  AgentRelease,
  AgentUpdateJob,
  Device,
  DeviceCheckin,
  DeviceSecret,
  DeviceUpdateEvent,
  DeviceUpdateState,
  Setting,
  Update,
  User,
};

/** Eine Liste, damit DataSource und TypeOrmModule nicht auseinanderlaufen koennen. */
export const ALL_ENTITIES = [
  AdSyncRun,
  AgentRelease,
  AgentUpdateJob,
  Device,
  DeviceCheckin,
  DeviceSecret,
  DeviceUpdateEvent,
  DeviceUpdateState,
  Setting,
  Update,
  User,
];
