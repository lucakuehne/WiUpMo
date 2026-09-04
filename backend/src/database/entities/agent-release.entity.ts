import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Hochgeladene Agent-Binaries fuer das Selbst-Update (Phase 6). */
@Entity('agent_releases')
export class AgentRelease {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  version: string;

  @Column({ type: 'text', name: 'file_path' })
  filePath: string;

  /** Der Agent prueft das heruntergeladene Binary gegen diesen Hash. */
  @Column({ type: 'text' })
  sha256: string;

  /** Als Zeichenkette, weil die Spalte bigint ist. */
  @Column({ type: 'bigint', name: 'size_bytes', default: 0 })
  sizeBytes: string;

  @Column({ type: 'timestamptz', name: 'released_at', default: () => 'now()' })
  releasedAt: Date;

  @Column({ type: 'boolean', name: 'is_current', default: false })
  isCurrent: boolean;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
