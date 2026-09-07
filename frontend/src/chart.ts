import { computed } from 'vue';
import { isDark } from '@/theme';

/**
 * Farben für die Diagramme.
 *
 * Als feste Werte und nicht aus den CSS-Variablen gelesen: Die Tokens in
 * `main.css` stehen in `oklch()`, und der Farbparser von Chart.js kennt diese
 * Schreibweise nicht — er käme mit einem stillen Schwarz heraus. Die Werte hier
 * entsprechen den Farbtönen der Abzeichen, damit Tabelle und Diagramm dieselbe
 * Sprache sprechen.
 */
interface Palette {
  text: string;
  muted: string;
  grid: string;
  series: string[];
}

const LIGHT: Palette = {
  text: '#3f3f46',
  muted: '#71717a',
  grid: 'rgba(0, 0, 0, 0.08)',
  series: ['#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#94a3b8', '#f43f5e'],
};

const DARK: Palette = {
  text: '#e4e4e7',
  muted: '#a1a1aa',
  grid: 'rgba(255, 255, 255, 0.10)',
  series: ['#60a5fa', '#4ade80', '#fbbf24', '#a78bfa', '#a1a1aa', '#fb7185'],
};

export const palette = computed<Palette>(() => (isDark.value ? DARK : LIGHT));

/** Achsen und Legende, wie sie in jedem Diagramm gleich aussehen sollen. */
export const baseOptions = computed(() => ({
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: palette.value.text, boxWidth: 12, boxHeight: 12 } },
  },
}));
