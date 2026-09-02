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
