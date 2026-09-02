<script setup lang="ts">
import Button from 'primevue/button';
import Menubar from 'primevue/menubar';
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { auth, logout } from '@/auth';

const route = useRoute();
const router = useRouter();

// Anmeldung und Einrichtung bekommen keine Navigation — dort gibt es nichts
// zu navigieren, und eine Menuleiste ueber einem Anmeldeformular sieht nach
// einem Fehler aus.
const showNavigation = computed(
  () => auth.authenticated && route.name !== 'login' && route.name !== 'setup',
);

const items = [
  { label: 'Geräte', icon: 'pi pi-desktop', route: '/devices' },
  { label: 'Updates', icon: 'pi pi-download', route: '/updates' },
];

async function onLogout(): Promise<void> {
  await logout();
  await router.push({ name: 'login' });
}

onMounted(() => {
  // Dunkelmodus nach Systemeinstellung. PrimeVue schaltet ueber die Klasse am
  // Wurzelelement, siehe darkModeSelector in main.ts.
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (dark: boolean) => document.documentElement.classList.toggle('dark', dark);
  apply(media.matches);
  media.addEventListener('change', (event) => apply(event.matches));
});
</script>

<template>
  <Menubar v-if="showNavigation" :model="items">
    <template #start>
      <span style="font-weight: 600; margin-right: 1rem">Windows Update Monitoring</span>
    </template>

    <template #item="{ item, props }">
      <router-link v-if="item.route" :to="item.route" custom v-slot="{ href, navigate }">
        <a :href="href" v-bind="props.action" @click="navigate">
          <span :class="item.icon" />
          <span style="margin-left: 0.5rem">{{ item.label }}</span>
        </a>
      </router-link>
    </template>

    <template #end>
      <div style="display: flex; align-items: center; gap: 0.75rem">
        <span class="muted">{{ auth.username }}</span>
        <Button
          label="Abmelden"
          icon="pi pi-sign-out"
          severity="secondary"
          text
          size="small"
          @click="onLogout"
        />
      </div>
    </template>
  </Menubar>

  <router-view />
</template>
