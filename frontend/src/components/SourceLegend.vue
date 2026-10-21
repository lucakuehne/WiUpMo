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
 * Erkennung leistet, wäre schlimmer als keine. Agents bis 0.6.2 meldeten jedes
 * Gerät am WSUS ohne DisableDualScan als Dual Scan — unter Windows 11 also
 * praktisch alle.
 */
const ENTRIES = [
  {
    label: 'WSUS',
    text: 'Der interne WSUS-Server ist per Richtlinie gesetzt, und Windows meldet, dass es alle Updates dort sucht. Das Gerät bekommt ausschliesslich, was dort freigegeben ist.',
  },
  {
    label: 'Dual Scan',
    text: 'WSUS ist per Richtlinie gesetzt, Windows holt aber einen Teil der Updates direkt bei Microsoft — die Freigabe auf dem WSUS gilt für dieses Gerät also nicht vollständig. Unter Windows 11 legt das die Richtlinie „Quelldienst für bestimmte Klassen von Windows-Updates angeben" fest, unter älterem Windows 10 entsteht es durch Zurückstellungen von Windows Update for Business. Massgeblich ist, was Windows selbst als wirksam meldet, nicht eine einzelne Richtlinie.',
  },
  {
    label: 'Intune',
    text: 'Kein WSUS per Richtlinie, dafür eine abgeschlossene MDM-Verwaltung. Die Updates steuert Windows Update for Business.',
  },
  {
    label: 'Microsoft Update',
    text: 'Das Gerät bezieht direkt von Microsoft: weder WSUS noch MDM, oder ein WSUS ist eingetragen, aber jede Update-Klasse ist auf Windows Update umgestellt.',
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
