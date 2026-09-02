import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { PG_ENUM, UpdateSource } from '../enums.js';
import { Device } from './device.entity.js';

@Entity('device_checkins')
@Index('idx_device_checkins_device_collected', ['deviceId', 'collectedAt'])
export class DeviceCheckin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  @ManyToOne(() => Device, (device) => device.checkins, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Relation<Device>;

  /**
   * Vom Agent erzeugte GUID. Die Eindeutigkeitsbedingung darauf ist der
   * gesamte Idempotenzmechanismus: laeuft eine Antwort in einen Timeout,
   * obwohl das Backend den Snapshot verarbeitet hat, sendet der Agent ihn
   * erneut — der zweite Versuch prallt an diesem Index ab.
   */
  @Column({ type: 'uuid', name: 'snapshot_id', unique: true })
  snapshotId: string;

  /** Erfassungszeitpunkt auf dem Geraet (UTC). */
  @Column({ type: 'timestamptz', name: 'collected_at' })
  collectedAt: Date;

  /** Empfangszeitpunkt im Backend. Bei Offline-Nachreichung deutlich spaeter. */
  @Column({ type: 'timestamptz', name: 'reported_at', default: () => 'now()' })
  reportedAt: Date;

  @Column({ type: 'text', name: 'agent_version', nullable: true })
  agentVersion: string | null;

  @Column({
    type: 'enum',
    enum: UpdateSource,
    enumName: PG_ENUM.updateSource,
    name: 'update_source',
    default: UpdateSource.Unknown,
  })
  updateSource: UpdateSource;

  @Column({ type: 'text', name: 'wsus_server_url', nullable: true })
  wsusServerUrl: string | null;

  @Column({ type: 'boolean', name: 'pending_reboot', default: false })
  pendingReboot: boolean;

  /**
   * Vollstaendiger Snapshot als Rohdaten. Nur zur Fehlersuche gedacht und
   * ueber die Aufbewahrungsfrist ohnehin begrenzt — nichts darf fachlich
   * darauf aufbauen.
   */
  @Column({ type: 'jsonb', name: 'raw_snapshot', nullable: true })
  rawSnapshot: Record<string, unknown> | null;
}
