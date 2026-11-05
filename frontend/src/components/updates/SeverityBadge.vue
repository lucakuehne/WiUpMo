<script setup lang="ts">
import { Badge } from '@/components/ui/badge';

/**
 * Einstufung eines Sicherheitsupdates, wie Microsoft sie vergibt. Andere
 * Updates tragen keine, die Zelle bleibt dann leer — ein „—" statt einer
 * erfundenen Stufe.
 */
defineProps<{ update: { isSecurity: boolean; severity: string | null } }>();
</script>

<template>
  <Badge
    v-if="update.isSecurity"
    variant="outline"
    class="bg-destructive/15 text-destructive border-destructive/30"
  >
    {{ update.severity ?? 'Sicherheit' }}
  </Badge>
  <span v-else class="text-muted-foreground">—</span>
</template>
