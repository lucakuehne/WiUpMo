import type { HardwareInfo } from '@/api/types';

/** Hersteller, wie man sie liest — WMI liefert sie, wie sie im BIOS stehen. */
const MANUFACTURERS: Record<string, string> = {
  LENOVO: 'Lenovo',
  'DELL INC.': 'Dell',
  HP: 'HP',
  'HEWLETT-PACKARD': 'HP',
  'MICROSOFT CORPORATION': 'Microsoft',
  'ASUSTEK COMPUTER INC.': 'ASUS',
  'FUJITSU CLIENT COMPUTING LIMITED': 'Fujitsu',
  FUJITSU: 'Fujitsu',
  'ACER': 'Acer',
};

export function manufacturerName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return MANUFACTURERS[value.trim().toUpperCase()] ?? value;
}

/**
 * „Lenovo ThinkPad T14 Gen 4“, „HP ProBook 445 G8 Notebook PC“.
 *
 * Bei Lenovo steht im Modell die Maschinentyp-Nummer (21HD003LMZ), der lesbare
 * Name in der Produktfamilie; bei den übrigen ist es umgekehrt, und die Familie
 * ist oft eine interne Kennung.
 */
export function deviceName(hardware: HardwareInfo | null | undefined): string | null {
  if (!hardware) return null;
  const maker = manufacturerName(hardware.manufacturer);
  const lenovo = maker === 'Lenovo';
  const model = (lenovo ? hardware.family : hardware.model) ?? hardware.model ?? hardware.family;
  if (!model) return maker ?? null;
  if (!maker || model.toLowerCase().startsWith(maker.toLowerCase())) return model;
  return `${maker} ${model}`;
}

export const CHASSIS_LABELS: Record<NonNullable<HardwareInfo['chassis']>, string> = {
  notebook: 'Notebook',
  desktop: 'Desktop',
  tablet: 'Tablet',
  server: 'Server',
  virtual: 'Virtuelle Maschine',
  other: 'Sonstiges',
};

export const BITLOCKER_LABELS: Record<string, string> = {
  on: 'verschlüsselt',
  off: 'nicht verschlüsselt',
  suspended: 'angehalten',
  encrypting: 'wird verschlüsselt',
  decrypting: 'wird entschlüsselt',
};

export const ADAPTER_LABELS: Record<string, string> = {
  wifi: 'WLAN',
  ethernet: 'Ethernet',
  bluetooth: 'Bluetooth',
  mobile: 'Mobilfunk',
  other: 'Sonstiges',
};

/** Binär gerechnet wie im Explorer, bis Terabyte. */
export function formatCapacity(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Anteil der ursprünglichen Kapazität, den der Akku noch hält, in Prozent. */
export function batteryHealth(battery: HardwareInfo['battery']): number | null {
  if (!battery?.designCapacityMwh || !battery.fullChargeCapacityMwh) return null;
  return Math.min(100, Math.round((battery.fullChargeCapacityMwh / battery.designCapacityMwh) * 100));
}
