import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { AdSyncStatus, AdSyncTrigger, PG_ENUM } from '../enums.js';

/** Protokoll je AD-Abgleich. Wird ab Phase 3 befuellt. */
@Entity('ad_sync_runs')
export class AdSyncRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'timestamptz', name: 'started_at', default: () => 'now()' })
  startedAt: Date;

  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'enum', enum: AdSyncTrigger, enumName: PG_ENUM.adSyncTrigger })
  trigger: AdSyncTrigger;

  @Column({ type: 'int', name: 'devices_found', default: 0 })
  devicesFound: number;

  @Column({ type: 'int', name: 'devices_created', default: 0 })
  devicesCreated: number;

  @Column({ type: 'int', name: 'devices_archived', default: 0 })
  devicesArchived: number;

  @Column({
    type: 'enum',
    enum: AdSyncStatus,
    enumName: PG_ENUM.adSyncStatus,
    default: AdSyncStatus.Running,
  })
  status: AdSyncStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
