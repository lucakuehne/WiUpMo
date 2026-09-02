import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DeviceStatus, PG_ENUM } from '../enums.js';
import { DeviceSecret } from './device-secret.entity.js';
import { DeviceCheckin } from './device-checkin.entity.js';
import { DeviceUpdateState } from './device-update-state.entity.js';

@Entity('devices')
@Index('idx_devices_last_seen_at', ['lastSeenAt'])
@Index('idx_devices_status', ['status'])
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  hostname: string;

  @Column({ type: 'text', name: 'ad_dn', nullable: true })
  adDn: string | null;

  /**
   * Der stabile Schluessel gegenueber dem AD. Hostnamen aendern sich, die
   * objectGUID nicht — daran haengt die Zuordnung ueber Umbenennungen hinweg.
   */
  @Column({ type: 'uuid', name: 'ad_object_guid', nullable: true, unique: true })
  adObjectGuid: string | null;

  @Column({ type: 'text', name: 'ad_ou', nullable: true })
  adOu: string | null;

  @Column({ type: 'text', name: 'os_name', nullable: true })
  osName: string | null;

  @Column({ type: 'text', name: 'os_version', nullable: true })
  osVersion: string | null;

  @Column({ type: 'text', name: 'os_build', nullable: true })
  osBuild: string | null;

  /** Gesetzt, sobald sich ein Agent registriert hat. Null = Geraet nur aus dem AD bekannt. */
  @Column({ type: 'timestamptz', name: 'enrolled_at', nullable: true })
  enrolledAt: Date | null;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'text', name: 'agent_version', nullable: true })
  agentVersion: string | null;

  @Column({
    type: 'enum',
    enum: DeviceStatus,
    enumName: PG_ENUM.deviceStatus,
    default: DeviceStatus.Active,
  })
  status: DeviceStatus;

  @Column({ type: 'timestamptz', name: 'archived_at', nullable: true })
  archivedAt: Date | null;

  @Column({ type: 'text', name: 'archived_reason', nullable: true })
  archivedReason: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => DeviceSecret, (secret) => secret.device)
  secrets: DeviceSecret[];

  @OneToMany(() => DeviceCheckin, (checkin) => checkin.device)
  checkins: DeviceCheckin[];

  @OneToMany(() => DeviceUpdateState, (state) => state.device)
  updateStates: DeviceUpdateState[];
}
