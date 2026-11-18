/**
 * `WU_E_UH_POSTREBOOTSTILLPENDING` — das Update ist eingespielt, sein Abschluss
 * steht bis zum Neustart aus.
 *
 * Windows meldet den Eintrag mit einem Ergebniscode, der auf Misserfolg
 * lautet, obwohl das Update eingespielt ist. Als Fehlschlag gezaehlt landete
 * jedes Geraet mit ausstehendem Neustart in der Auswertung "wiederholt
 * gescheiterte Installationen" — und zwar genau die, die gerade alles richtig
 * gemacht haben.
 *
 * Bis zum Neustart bietet die Suche das Update weiter an. Es steht dann als
 * offen da, ist aber nicht mehr zu installieren: Ein Auftrag dafuer braechte
 * nichts. Nach dem Neustart schreibt Windows das Endergebnis, und das Update
 * verschwindet aus der Verfuegbar-Liste.
 *
 * Der Vergleich laeuft ueber die vorzeichenlose Form: Der Agent reicht den
 * HRESULT als vorzeichenbehaftete 32-Bit-Zahl durch, andere Quellen tun es
 * nicht, und `>>> 0` bringt beide auf denselben Wert.
 */
export const WU_E_UH_POSTREBOOTSTILLPENDING = 0x80242014;

export function isPostRebootPending(hresult: number | null | undefined): boolean {
  return hresult !== null && hresult !== undefined
    ? (hresult >>> 0) === WU_E_UH_POSTREBOOTSTILLPENDING
    : false;
}

/**
 * Dasselbe als SQL ueber eine Zeile von `device_update_states`. Dort steht
 * bei einem weiter angebotenen Update der HRESULT des letzten Versuchs.
 */
export function postRebootPendingSql(alias: string): string {
  return `coalesce((${alias}.hresult::bigint & 4294967295) = ${WU_E_UH_POSTREBOOTSTILLPENDING}, false)`;
}

/**
 * Dasselbe ueber ein Ereignis aus `device_update_events`; dort steht der
 * HRESULT des Historieneintrags in `details`.
 */
export function postRebootPendingEventSql(alias: string): string {
  return `coalesce(((${alias}.details->>'hresult')::bigint & 4294967295) = ${WU_E_UH_POSTREBOOTSTILLPENDING}, false)`;
}

/**
 * Ob ein Neustart ein eingespieltes Update nicht abgeschlossen hat: Es war vor
 * dem letzten Systemstart eingespielt (`0x80242014`) und wird danach weiter
 * angeboten.
 *
 * Normalerweise schliesst der Neustart ab, und das Update verschwindet aus dem
 * Angebot. Bleibt es, ist der Abschluss gescheitert — bei Funktionsupdates
 * meist ein Rueckbau durch Windows-Setup —, und Windows spielt es erneut ein.
 * Im Verlauf sieht diese Schleife sonst nach lauter Erfolgen aus.
 *
 * „Danach angeboten" heisst: Der Zustand stammt aus einem Check-in nach dem
 * Systemstart (`last_reported_at`). `last_seen_at` genuegte nicht — ein
 * Check-in ohne Update-Daten zaehlt dort mit, bestaetigt das Angebot aber
 * nicht. Ein Einspielen aus einer frueheren Runde, nach der das Update schon
 * einmal verschwunden oder fertig installiert war, zaehlt nicht.
 */
export function notCompletedByRebootSql(stateAlias: string, deviceAlias: string): string {
  const s = stateAlias;
  const d = deviceAlias;
  return `(${s}.state = 'available'
    AND ${d}.last_boot_at IS NOT NULL
    AND ${s}.last_reported_at > ${d}.last_boot_at
    AND EXISTS (
      SELECT 1 FROM device_update_events staged
       WHERE staged.device_id = ${s}.device_id
         AND staged.update_id = ${s}.update_id
         AND staged.event_type = 'installed'
         AND ${postRebootPendingEventSql('staged')}
         AND staged.occurred_at < ${d}.last_boot_at
         AND NOT EXISTS (
           SELECT 1 FROM device_update_events ended
            WHERE ended.device_id = staged.device_id
              AND ended.update_id = staged.update_id
              AND ended.occurred_at > staged.occurred_at
              AND (ended.event_type = 'disappeared'
                   OR (ended.event_type = 'installed' AND NOT ${postRebootPendingEventSql('ended')}))
         )
    ))`;
}
