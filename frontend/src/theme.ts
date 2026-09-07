import { ref } from 'vue';

/**
 * Das aktive Erscheinungsbild, reaktiv.
 *
 * An einer Stelle statt in jeder Ansicht: Die Diagramme brauchen ihre Farben
 * als Zeichenketten und können sie nicht aus CSS beziehen — sie müssen also
 * mitbekommen, wenn sich das Erscheinungsbild ändert. Über die Klasse am
 * Wurzelelement liesse sich das nicht beobachten, ohne einen MutationObserver
 * aufzusetzen.
 */
export const isDark = ref(false);

const media = window.matchMedia('(prefers-color-scheme: dark)');

isDark.value = media.matches;
media.addEventListener('change', (event) => {
  isDark.value = event.matches;
});
