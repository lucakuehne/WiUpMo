import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Laufzeitkonfiguration, die im Frontend aenderbar sein soll — Sync-Intervall,
 * Aufbewahrungsfrist, Schwellwerte, Auth-Provider. Alles, was schon zum
 * Startzeitpunkt feststehen muss (Datenbankzugang, Enrollment-Token), gehoert
 * dagegen in die Umgebungsvariablen.
 *
 * Der Wert ist `jsonb`, damit Zahlen, Wahrheitswerte und Listen ohne
 * Zeichenketten-Umweg gespeichert werden koennen.
 */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
