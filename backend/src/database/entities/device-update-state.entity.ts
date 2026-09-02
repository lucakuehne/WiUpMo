import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { PG_ENUM, UpdateState } from '../enums.js';
import { Device } from './device.entity.js';
import { Update } from './update.entity.js';

/**
 * Aktueller Stand je Geraet und Update — die Tabelle, gegen die das Frontend
 * abfragt. Die Historie liegt getrennt in `device_update_events`, damit sie
 * nach Ablauf der Aufbewahrungsfrist beschnitten werden kann, ohne den
 * aktuellen Stand zu beschaedigen.
 */
@Entity('device_update_states')
@Index('idx_device_update_states_device_state', ['deviceId', 'state'])
@Index('idx_device_update_states_update', ['updateId'])
export class DeviceUpdateState {
  @PrimaryColumn({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  @PrimaryColumn({ type: 'uuid', name: 'update_id' })
  updateId: string;

  @ManyToOne(() => Device, (device) => device.updateStates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Relation<Device>;

  @ManyToOne(() => Update, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'update_id' })
  update: Relation<Update>;

  @Column({ type: 'enum', enum: UpdateState, enumName: PG_ENUM.updateState })
  state: UpdateState;

  /**
   * Wann das Update auf diesem Geraet erstmals als verfuegbar gemeldet wurde.
   * Zusammen mit `installedAt` ergibt das die Time-to-Patch-Kennzahl.
   */
  @Column({ type: 'timestamptz', name: 'first_available_at', nullable: true })
  firstAvailableAt: Date | null;

  @Column({ type: 'timestamptz', name: 'installed_at', nullable: true })
  installedAt: Date | null;

  /** `OperationResultCode` der Windows-Update-API (0 = nicht gestartet … 5 = abgebrochen). */
  @Column({ type: 'int', name: 'result_code', nullable: true })
  resultCode: number | null;

  /** Vorzeichenbehafteter 32-Bit-Fehlercode, z. B. -2145124329 fuer 0x80240017. */
  @Column({ type: 'int', nullable: true })
  hresult: number | null;

  @Column({ type: 'boolean', name: 'reboot_required', default: false })
  rebootRequired: boolean;

  @Column({ type: 'timestamptz', name: 'last_reported_at' })
  lastReportedAt: Date;
}
