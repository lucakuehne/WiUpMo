import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Update-Katalog, global ueber alle Geraete. Ein Update wird einmal gespeichert,
 * die geraetespezifische Sicht haengt in `device_update_states`.
 */
@Entity('updates')
@Index('idx_updates_kb_article', ['kbArticle'])
@Index('idx_updates_is_security', ['isSecurity'])
export class Update {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** `IUpdateIdentity.UpdateID` aus der Windows-Update-API (eine GUID). */
  @Column({ type: 'text', name: 'update_id', unique: true })
  updateId: string;

  /**
   * `IUpdateIdentity.RevisionNumber`. Microsoft ueberarbeitet Updates unter
   * gleichbleibender UpdateID; ohne die Revision liesse sich nicht erkennen,
   * dass die Metadaten im Katalog veraltet sind.
   */
  @Column({ type: 'int', name: 'revision_number', nullable: true })
  revisionNumber: number | null;

  /** Ohne fuehrendes "KB", z. B. `5034123`. */
  @Column({ type: 'text', name: 'kb_article', nullable: true })
  kbArticle: string | null;

  @Column({ type: 'text' })
  title: string;

  /** `MsrcSeverity`: Critical / Important / Moderate / Low. Nicht jedes Update hat eine. */
  @Column({ type: 'text', nullable: true })
  severity: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  categories: string[];

  @Column({ type: 'boolean', name: 'is_security', default: false })
  isSecurity: boolean;

  @Column({ type: 'text', name: 'msrc_number', nullable: true })
  msrcNumber: string | null;

  @Column({ type: 'bigint', name: 'size_bytes', nullable: true })
  sizeBytes: string | null;

  @Column({ type: 'text', name: 'support_url', nullable: true })
  supportUrl: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'first_seen_at' })
  firstSeenAt: Date;
}
