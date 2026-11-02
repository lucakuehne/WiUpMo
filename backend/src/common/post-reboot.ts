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
