import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { AgentUpdateJobDto } from '../../releases/dto/release.dto.js';
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
   * Auftrag zum Selbst-Update, sofern einer offen ist.
   *
   * Der Typ ist ausdruecklich mit verzoegertem Verweis angegeben. Das Feld war
   * bis Phase 6 ein `null`-Platzhalter, und daran ist das Backend beim Start
   * gescheitert: Aus einem `null` kann das Swagger-Plugin kein Schema
   * ableiten, es laesst `type` weg, und Swagger setzt ersatzweise die
   * umgebende Klasse ein — was als Zirkelbezug abbricht.
   */
  @ApiProperty({
    type: () => AgentUpdateJobDto,
    nullable: true,
    required: false,
    description: 'Auftrag zum Selbst-Update, sonst null.',
  })
  agentUpdate: AgentUpdateJobDto | null = null;
}
