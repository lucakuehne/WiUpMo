import { createRouter, createWebHistory } from 'vue-router';
import { setUnauthorizedHandler } from '@/api/client';
import { auth, markSignedOut, refresh } from '@/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('@/views/DashboardView.vue') },
    { path: '/setup', name: 'setup', component: () => import('@/views/SetupView.vue') },
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
    { path: '/devices', name: 'devices', component: () => import('@/views/DevicesView.vue') },
    {
      path: '/devices/:id',
      name: 'device',
      component: () => import('@/views/DeviceDetailView.vue'),
      props: true,
    },
    { path: '/updates', name: 'updates', component: () => import('@/views/UpdatesView.vue') },
    { path: '/reports', name: 'reports', component: () => import('@/views/ReportsView.vue') },
    { path: '/ad', name: 'ad', component: () => import('@/views/AdSyncView.vue') },
    {
      path: '/agent-releases',
      name: 'releases',
      component: () => import('@/views/AgentReleasesView.vue'),
    },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/**
 * Ein einziger Wachposten fuer alle drei Zustaende. Die Reihenfolge ist
 * wesentlich: Solange kein Benutzer existiert, fuehrt jeder Weg zur
 * Einrichtung — auch der zur Anmeldung, an der sich niemand anmelden koennte.
 */
router.beforeEach(async (to) => {
  await refresh();

  if (auth.setupRequired) {
    return to.name === 'setup' ? true : { name: 'setup' };
  }

  // Die Einrichtung ist abgeschlossen; ihre Seite ist damit erledigt.
  if (to.name === 'setup') {
    return { name: auth.authenticated ? 'dashboard' : 'login' };
  }

  if (!auth.authenticated && to.name !== 'login') {
    return { name: 'login', query: { weiter: to.fullPath } };
  }

  if (auth.authenticated && to.name === 'login') {
    return { name: 'dashboard' };
  }

  return true;
});

/**
 * Läuft die Sitzung während der Benutzung ab, führt der nächste API-Aufruf
 * hierher — mit dem aktuellen Pfad, damit es danach dort weitergeht.
 */
setUnauthorizedHandler(() => {
  markSignedOut();

  if (router.currentRoute.value.name !== 'login') {
    void router.replace({ name: 'login', query: { weiter: router.currentRoute.value.fullPath } });
  }
});

export default router;
