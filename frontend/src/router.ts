import { createRouter, createWebHistory } from 'vue-router';
import { auth, refresh } from '@/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/devices' },
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
    { path: '/ad', name: 'ad', component: () => import('@/views/AdSyncView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/devices' },
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
    return { name: auth.authenticated ? 'devices' : 'login' };
  }

  if (!auth.authenticated && to.name !== 'login') {
    return { name: 'login', query: { weiter: to.fullPath } };
  }

  if (auth.authenticated && to.name === 'login') {
    return { name: 'devices' };
  }

  return true;
});

export default router;
