import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PG_ENUM, UpdateEventType } from '../enums.js';
import { Device } from './device.entity.js';
import { Update } from './update.entity.js';

/**
 * Zeitreihe, ausschliesslich angehaengt, nie geaendert. Waechst um Groessen-
 * ordnungen schneller als die uebrigen Tabellen und wird vom Retention-Job
 * beschnitten.
 *
 * Der Schluessel ist `bigserial`, nicht uuid: bei append-only-Volumen ist ein
 * monoton wachsender 8-Byte-Wert deutlich index-freundlicher als eine
 * zufaellige 16-Byte-UUID.
 */
@Entity('device_update_events')
@Index('idx_device_update_events_device_occurred', ['deviceId', 'occurredAt'])
@Index('idx_device_update_events_occurred', ['occurredAt'])
export class DeviceUpdateEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Device;

  @Column({ type: 'uuid', name: 'update_id' })
  updateId: string;

  @ManyToOne(() => Update, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'update_id' })
  update: Update;

  @Column({
    type: 'enum',
    enum: UpdateEventType,
    enumName: PG_ENUM.updateEventType,
    name: 'event_type',
  })
  eventType: UpdateEventType;

  /** Lokaler Zeitpunkt auf dem Geraet — massgeblich fuer jede Zeitreihe. */
  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt: Date;

  /**
   * Zeitpunkt des Eingangs im Backend. Weicht bei nachgereichten Offline-
   * Snapshots deutlich von `occurredAt` ab; die Trennung ist der Grund, warum
   * die Auswertung trotz Offline-Puffer stimmt.
   */
  @Column({ type: 'timestamptz', name: 'reported_at', default: () => 'now()' })
  reportedAt: Date;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, unknown> | null;
}
