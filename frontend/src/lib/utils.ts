import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Klassennamen zusammenführen.
 *
 * `clsx` löst Bedingungen und Arrays auf, `tailwind-merge` entfernt danach
 * Widersprüche: Steht in einer Komponente `px-4` und beim Aufruf `px-2`,
 * gewinnt der Aufruf. Ohne diesen Schritt stünden beide im Klassenattribut
 * und es entschiede die Reihenfolge im erzeugten Stylesheet — also der Zufall.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
