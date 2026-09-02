<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { login } from '@/auth';

const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function submit(): Promise<void> {
  error.value = null;
  busy.value = true;

  try {
    await login(username.value, password.value);

    // Zurueck dorthin, wo der Benutzer eigentlich hinwollte, bevor der
    // Wachposten ihn hierher geschickt hat.
    const target = typeof route.query.weiter === 'string' ? route.query.weiter : '/devices';
    await router.push(target);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Die Anmeldung ist fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="centered">
    <Card>
      <template #title>Anmeldung</template>
      <template #subtitle>Windows Update Monitoring</template>

      <template #content>
        <form @submit.prevent="submit">
          <div class="field">
            <label for="username">Benutzername</label>
            <InputText id="username" v-model="username" autocomplete="username" autofocus />
          </div>

          <div class="field">
            <label for="password">Passwort</label>
            <Password
              id="password"
              v-model="password"
              autocomplete="current-password"
              toggle-mask
              :feedback="false"
              fluid
            />
          </div>

          <Message v-if="error" severity="error" :closable="false" style="margin-bottom: 1rem">
            {{ error }}
          </Message>

          <Button
            type="submit"
            label="Anmelden"
            :loading="busy"
            :disabled="!username || !password"
            fluid
          />
        </form>
      </template>
    </Card>
  </div>
</template>
