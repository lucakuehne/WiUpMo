<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AgentReleases from '@/components/AgentReleases.vue';
import AgentProblemsTab from '@/components/agents/AgentProblemsTab.vue';
import AgentRolloutsTab from '@/components/agents/AgentRolloutsTab.vue';

const props = defineProps<{ section?: string }>();

const router = useRouter();

type Section = 'updates' | 'versions' | 'problems';

/**
 * Der Tab steht im Pfad wie bei den Windows-Updates: Ein Link aus der
 * Bestätigung eines Ausrollens führt so direkt zu „Agent-Updates", und alte
 * Lesezeichen auf die Versionen landen unter „Versionen".
 */
const tab = computed<Section>({
  get: () => (props.section === 'versions' || props.section === 'problems' ? props.section : 'updates'),
  set: (value) => {
    void router.push({ name: 'agents', params: { section: value === 'updates' ? undefined : value } });
  },
});
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <h1 class="mb-4 text-xl font-semibold">Agents</h1>

    <Tabs v-model="tab">
      <TabsList class="mb-3">
        <TabsTrigger value="updates">Agent-Updates</TabsTrigger>
        <TabsTrigger value="versions">Versionen</TabsTrigger>
        <TabsTrigger value="problems">Störungen</TabsTrigger>
      </TabsList>

      <TabsContent value="updates"><AgentRolloutsTab /></TabsContent>
      <TabsContent value="versions"><AgentReleases /></TabsContent>
      <TabsContent value="problems"><AgentProblemsTab /></TabsContent>
    </Tabs>
  </div>
</template>
