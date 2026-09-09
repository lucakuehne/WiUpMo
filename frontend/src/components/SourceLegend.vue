<script setup lang="ts">
import HelpLegend from '@/components/HelpLegend.vue';

/**
 * Erklärt die Update-Quellen.
 *
 * Steht überall dort, wo eine Quelle angezeigt wird. Der Grund ist „Dual Scan":
 * Der Begriff steht in keiner Oberfläche von Microsoft, beschreibt aber genau
 * den Zustand, um dessentwillen diese Auswertung existiert — und ohne Erklärung
 * liest man ihn als „irgendwas mit zwei Servern" statt als „die WSUS-Freigabe
 * greift hier nicht".
 *
 * Die Formulierungen folgen dem, was der Agent tatsächlich auswertet (siehe
 * UpdateSourceInspector.cs); eine Legende, die etwas anderes verspricht als die
 * Erkennung leistet, wäre schlimmer als keine.
 */
const ENTRIES = [
  {
    label: 'WSUS',
    text: 'Der interne WSUS-Server ist per Richtlinie gesetzt und der Zugriff aufs Internet gesperrt. Das Gerät bekommt ausschliesslich, was dort freigegeben ist.',
  },
  {
    label: 'Dual Scan',
    text: 'WSUS ist per Richtlinie gesetzt, der Zugriff aufs Internet aber nicht gesperrt. Windows holt sich daneben Updates direkt bei Microsoft — die Freigabe auf dem WSUS gilt für dieses Gerät also nicht mehr zuverlässig. Abstellen lässt sich das mit DisableDualScan bzw. DoNotConnectToWindowsUpdateInternetLocations.',
  },
  {
    label: 'Intune',
    text: 'Kein WSUS per Richtlinie, dafür eine abgeschlossene MDM-Verwaltung. Die Updates steuert Windows Update for Business.',
  },
  {
    label: 'Microsoft Update',
    text: 'Weder WSUS noch MDM. Das Gerät bezieht direkt von Microsoft.',
  },
  {
    label: 'unbekannt',
    text: 'Keines dieser Merkmale war lesbar — meist ein Gerät, das sich noch nie gemeldet hat.',
  },
];
</script>

<template>
  <HelpLegend :entries="ENTRIES" caption="Was bedeuten die Update-Quellen?" />
</template>
