<script setup lang="ts">
import HelpLegend from '@/components/HelpLegend.vue';

/**
 * Erklärt die Status eines Update-Auftrags.
 *
 * Die Reihenfolge ist der Weg, den ein Auftrag nimmt — schon daran lässt sich
 * ablesen, ob ein Gerät hängt oder nur noch nicht dran war.
 *
 * Die Beschreibungen folgen dem, was Agent und Backend tatsächlich tun (siehe
 * SelfUpdateService.cs und Updater.cs). Besonders „wird installiert" ist ohne
 * Erklärung irreführend: Zu diesem Zeitpunkt liegt die neue Fassung erst
 * bereit, getauscht wird sie von einem anderen Prozess.
 */
const ENTRIES = [
  {
    label: 'offen',
    text: 'Der Auftrag ist angelegt. Das Gerät hat sich seither nicht gemeldet und weiss noch nichts davon.',
  },
  {
    label: 'zugestellt',
    text: 'Das Gerät hat den Auftrag bei einem Check-in abgeholt.',
  },
  {
    label: 'wird installiert',
    text: 'Der Agent hat die Datei geladen, die Prüfsumme verglichen und sie bereitgelegt. Getauscht wird sie vom Updater-Task, der alle fünf Minuten läuft — bis zur Bestätigung vergehen typischerweise einige Minuten.',
  },
  {
    label: 'erledigt',
    text: 'Der Tausch ist bestätigt: Das Gerät läuft auf der Zielversion und hat das gemeldet.',
  },
  {
    label: 'gescheitert',
    text: 'Abgebrochen; der Grund steht in der Spalte „Fehler". Typisch sind eine nicht passende Prüfsumme, eine entfernte Zielversion oder ein neuer Dienst, der sich nicht bestätigt hat und deshalb zurückgetauscht wurde.',
  },
];
</script>

<template>
  <HelpLegend :entries="ENTRIES" caption="Was bedeuten die Status der Aufträge?" />
</template>
