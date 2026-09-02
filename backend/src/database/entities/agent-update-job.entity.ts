import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AgentUpdateJobState, PG_ENUM } from '../enums.js';
import { Device } from './device.entity.js';

/** Auftrag an ein Geraet, sich auf eine bestimmte Agent-Version zu aktualisieren (Phase 6). */
@Entity('agent_update_jobs')
@Index('idx_agent_update_jobs_device_state', ['deviceId', 'state'])
export class AgentUpdateJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Device;

  @Column({ type: 'text', name: 'target_version' })
  targetVersion: string;

  @Column({
    type: 'enum',
    enum: AgentUpdateJobState,
    enumName: PG_ENUM.agentUpdateJobState,
    default: AgentUpdateJobState.Pending,
  })
  state: AgentUpdateJobState;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
