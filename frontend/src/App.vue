<script setup lang="ts">
import {
  BarChart3,
  Box,
  Download,
  LineChart,
  LogOut,
  Monitor,
  RefreshCw,
  Settings,
} from '@lucide/vue';
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
import { auth, logout } from '@/auth';

const route = useRoute();
const router = useRouter();

// Anmeldung und Einrichtung bekommen keine Navigation — dort gibt es nichts zu
// navigieren, und eine Menüleiste über einem Anmeldeformular sieht nach einem
// Fehler aus.
const showNavigation = computed(
  () => auth.authenticated && route.name !== 'login' && route.name !== 'setup',
);

const items = [
  { label: 'Dashboard', icon: BarChart3, to: '/' },
  { label: 'Geräte', icon: Monitor, to: '/devices' },
  { label: 'Updates', icon: Download, to: '/updates' },
  { label: 'Auswertungen', icon: LineChart, to: '/reports' },
  { label: 'AD-Abgleich', icon: RefreshCw, to: '/ad' },
  { label: 'Agent-Versionen', icon: Box, to: '/agent-releases' },
  { label: 'Einstellungen', icon: Settings, to: '/settings' },
];

/** Die Wurzel darf nur bei genauer Übereinstimmung leuchten, sonst immer. */
function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path.startsWith(to);
}

async function onLogout(): Promise<void> {
  await logout();
  await router.push({ name: 'login' });
}

onMounted(() => {
  // Dunkelmodus nach Systemeinstellung; die Klasse am Wurzelelement ist das,
  // worauf die Farbvariablen in main.css hören.
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (dark: boolean) => document.documentElement.classList.toggle('dark', dark);
  apply(media.matches);
  media.addEventListener('change', (event) => apply(event.matches));
});
</script>

<template>
  <header v-if="showNavigation" class="border-b bg-card">
    <div class="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
      <span class="shrink-0 text-sm font-semibold">Windows Update Monitoring</span>

      <nav class="flex flex-1 items-center gap-1 overflow-x-auto">
        <router-link
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
          :class="
            isActive(item.to)
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          "
        >
          <component :is="item.icon" class="size-4" />
          {{ item.label }}
        </router-link>
      </nav>

      <div class="flex shrink-0 items-center gap-2">
        <span class="text-muted-foreground text-sm">{{ auth.username }}</span>
        <Button variant="ghost" size="sm" @click="onLogout">
          <LogOut class="size-4" />
          Abmelden
        </Button>
      </div>
    </div>
  </header>

  <router-view />
</template>
