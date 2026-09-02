import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { SnapshotDto } from './snapshot.dto.js';

export class BatchCheckinDto {
  /**
   * Gepufferte Snapshots aus der Offline-Warteschlange, aelteste zuerst.
   * Die Obergrenze entspricht der Warteschlangengroesse im Agent.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SnapshotDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  snapshots: SnapshotDto[];
}

export enum SnapshotOutcome {
  /** Verarbeitet und gespeichert. */
  Accepted = 'accepted',
  /** War bereits verarbeitet — der Agent hatte ihn schon einmal geschickt. */
  Duplicate = 'duplicate',
  /** Konnte nicht verarbeitet werden; der Agent soll ihn verwerfen, nicht wiederholen. */
  Rejected = 'rejected',
}

export class SnapshotResultDto {
  snapshotId: string;
  outcome: SnapshotOutcome;
  /** Nur bei `rejected` gesetzt. */
  error?: string;
}

export class CheckinResponseDto {
  results: SnapshotResultDto[];

  /**
   * Platzhalter fuer den Selbst-Update-Auftrag aus Phase 6. Steht schon im
   * Vertrag, damit aeltere Agents das Feld spaeter nicht als unbekannt
   * behandeln muessen.
   */
  agentUpdate: null = null;
}
