import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Lokale Benutzer fuer den Frontend-Login (Phase 4). Der Hash ist Argon2id —
 * hier geht es um erratbare Passwoerter, anders als bei den Geraete-Secrets.
 * Kein Rollenmodell: alle Benutzer haben dieselben Rechte.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  username: string;

  @Column({ type: 'text', name: 'password_hash' })
  passwordHash: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'last_login_at', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;
}
