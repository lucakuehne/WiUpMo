<script setup lang="ts">
import { CircleQuestionMark } from '@lucide/vue';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Ein „?" mit einer Legende dahinter.
 *
 * Die Hülle für alle Erklärungen dieser Art — die Begriffe selbst stehen in den
 * Komponenten, die sie brauchen. Zwei Tooltips mit derselben Verkabelung
 * nebeneinander wären zwei Stellen, an denen Abstand, Breite und Verhalten
 * auseinanderlaufen können.
 */
defineProps<{
  entries: Array<{ label: string; text: string }>;
  /** Was der Knopf für Hilfsmittel ankündigt. */
  caption: string;
}>();
</script>

<template>
  <TooltipProvider :delay-duration="150">
    <Tooltip>
      <TooltipTrigger
        type="button"
        class="text-muted-foreground hover:text-foreground align-middle transition-colors"
        :aria-label="caption"
      >
        <CircleQuestionMark class="size-3.5" />
      </TooltipTrigger>

      <TooltipContent class="w-80 space-y-1.5 p-3">
        <p v-for="entry in entries" :key="entry.label" class="leading-snug">
          <span class="font-semibold">{{ entry.label }}</span>
          <span class="text-background/80"> — {{ entry.text }}</span>
        </p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
