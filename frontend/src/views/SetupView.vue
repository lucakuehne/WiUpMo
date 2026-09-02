<script setup lang="ts">
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { setup } from '@/auth';

const router = useRouter();

const username = ref('');
const password = ref('');
const repeat = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function submit(): Promise<void> {
  error.value = null;

  if (password.value !== repeat.value) {
    error.value = 'Die beiden Passwörter stimmen nicht überein.';
    return;
  }

  busy.value = true;
  try {
    await setup(username.value, password.value);
    await router.push({ name: 'devices' });
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Die Einrichtung ist fehlgeschlagen.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="centered">
    <Card>
      <template #title>Einrichtung</template>

      <template #subtitle>
        Es existiert noch kein Benutzer. Dieses Konto wird das Administratorkonto.
      </template>

      <template #content>
        <Message severity="warn" :closable="false" style="margin-bottom: 1rem">
          Solange die Einrichtung offen ist, kann sie jeder abschliessen, der diese Seite erreicht.
          Bitte jetzt durchführen.
        </Message>

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
              autocomplete="new-password"
              toggle-mask
              :feedback="false"
              fluid
            />
            <small class="muted">Mindestens 12 Zeichen.</small>
          </div>

          <div class="field">
            <label for="repeat">Passwort wiederholen</label>
            <Password
              id="repeat"
              v-model="repeat"
              autocomplete="new-password"
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
            label="Einrichtung abschliessen"
            :loading="busy"
            :disabled="!username || !password"
            fluid
          />
        </form>
      </template>
    </Card>
  </div>
</template>
