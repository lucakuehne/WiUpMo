import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stuft `WU_E_UH_POSTREBOOTSTILLPENDING` nachtraeglich als Erfolg ein.
 *
 * Windows meldet zu einem Update, dessen Abschluss bis zum Neustart aussteht,
 * einen Ergebniscode, der auf Misserfolg lautet. Der Check-in hat das als
 * Fehlschlag uebernommen — mit der Folge, dass jedes Geraet mit ausstehendem
 * Neustart in der Auswertung "wiederholt gescheiterte Installationen" auftauchte
 * und in der Zeitreihe ein Fehlschlag stand.
 *
 * Kuenftige Meldungen behandelt der Check-in richtig. Die bereits gespeicherten
 * kaemen nicht von selbst in Ordnung: Der Agent schickt seine Historie nur
 * einmal, danach zeigt der Fortschrittsmarker dahinter.
 *
 * Die Ereignisse werden mitgezogen, obwohl sie eine Zeitreihe sind. Sie sind
 * unsere Deutung eines Historieneintrags, nicht der Eintrag selbst — der steht
 * unveraendert in `details`. Eine Deutung, die wir als falsch erkannt haben,
 * stehen zu lassen hiesse, zwei Antworten auf dieselbe Frage zu behalten.
 */
export class PostRebootPending1789600000000 implements MigrationInterface {
  name = 'PostRebootPending1789600000000';

  /** 0x80242014, so wie es als vorzeichenbehaftete 32-Bit-Zahl gespeichert ist. */
  private static readonly HRESULT = -2145116140;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `last_reported_at`, nicht `updated_at`: Die Tabelle fuehrt keinen
    // allgemeinen Aenderungszeitpunkt, sondern den des letzten Check-ins, der
    // diesen Zustand gemeldet hat. Das ist hier auch der genauere Wert.
    await queryRunner.query(
      `UPDATE device_update_states
          SET state        = 'installed',
              installed_at = COALESCE(installed_at, last_reported_at)
        WHERE state = 'failed' AND hresult = $1`,
      [PostRebootPending1789600000000.HRESULT],
    );

    await queryRunner.query(
      `UPDATE device_update_events
          SET event_type = 'installed'
        WHERE event_type = 'failed'
          AND details->>'hresult' = $1`,
      [String(PostRebootPending1789600000000.HRESULT)],
    );
  }

  /**
   * Kein Rueckweg: Nach der Korrektur laesst sich nicht mehr unterscheiden, ob
   * ein installierter Zustand aus dieser Migration stammt oder regulaer
   * entstanden ist. Ein Ruecksetzen "aller installierten mit diesem Code" traefe
   * auch die, die der Check-in kuenftig richtig einordnet.
   */
  public async down(): Promise<void> {
    // absichtlich leer
  }
}
