<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AllUpdatesTab from '@/components/updates/AllUpdatesTab.vue';
import InstallationsTab from '@/components/updates/InstallationsTab.vue';
import OpenUpdatesTab from '@/components/updates/OpenUpdatesTab.vue';

const props = defineProps<{ section?: string }>();

const router = useRouter();

type Section = 'open' | 'all' | 'installations';

/**
 * Der Tab steht im Pfad, damit ein Link — etwa aus dem Installationsdialog —
 * direkt auf „Installationen" führt und der Zurück-Knopf von einer
 * Detailseite wieder hier landet.
 */
const tab = computed<Section>({
  get: () => (props.section === 'all' || props.section === 'installations' ? props.section : 'open'),
  set: (value) => {
    void router.push({ name: 'updates', params: { section: value === 'open' ? undefined : value } });
  },
});
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-5 py-6">
    <h1 class="mb-4 text-xl font-semibold">Windows Updates</h1>

    <Tabs v-model="tab">
      <TabsList class="mb-3">
        <TabsTrigger value="open">Offene Updates</TabsTrigger>
        <TabsTrigger value="all">Alle Updates</TabsTrigger>
        <TabsTrigger value="installations">Installationen</TabsTrigger>
      </TabsList>

      <TabsContent value="open"><OpenUpdatesTab /></TabsContent>
      <TabsContent value="all"><AllUpdatesTab /></TabsContent>
      <TabsContent value="installations"><InstallationsTab /></TabsContent>
    </Tabs>
  </div>
</template>
