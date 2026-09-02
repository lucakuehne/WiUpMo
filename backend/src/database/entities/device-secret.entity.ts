import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Device } from './device.entity.js';

/**
 * Bewusst von `devices` getrennt: Geraeteabfragen im Frontend duerfen keine
 * Credentials mitziehen.
 *
 * Gespeichert wird ein SHA-256-Hash, nicht Argon2. Das Secret ist ein
 * serverseitig erzeugter Zufallswert mit 256 Bit Entropie — dagegen bringt eine
 * langsame Schluesselableitung nichts, weil es kein erratbares Passwort gibt.
 * Argon2id bleibt den Benutzerpasswoertern vorbehalten.
 */
@Entity('device_secrets')
@Index('idx_device_secrets_device_active', ['deviceId', 'revokedAt'])
export class DeviceSecret {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  @ManyToOne(() => Device, (device) => device.secrets, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Device;

  @Column({ type: 'text', name: 'secret_hash' })
  secretHash: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** Gesetzt beim Rotieren oder beim Sperren eines Geraets. */
  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;
}
