<script setup lang="ts">
import { Eye, EyeOff, Loader2 } from '@lucide/vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { login } from '@/auth';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const visible = ref(false);
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
  <div class="flex min-h-screen items-center justify-center px-5 py-10">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Anmeldung</CardTitle>
        <CardDescription>Windows Update Monitoring</CardDescription>
      </CardHeader>

      <CardContent>
        <form class="space-y-4" @submit.prevent="submit">
          <div class="space-y-1.5">
            <Label for="username">Benutzername</Label>
            <Input id="username" v-model="username" autocomplete="username" autofocus />
          </div>

          <div class="space-y-1.5">
            <Label for="password">Passwort</Label>
            <div class="relative">
              <Input
                id="password"
                v-model="password"
                :type="visible ? 'text' : 'password'"
                autocomplete="current-password"
                class="pr-9"
              />
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                :aria-label="visible ? 'Passwort verbergen' : 'Passwort anzeigen'"
                @click="visible = !visible"
              >
                <EyeOff v-if="visible" class="size-4" />
                <Eye v-else class="size-4" />
              </button>
            </div>
          </div>

          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <Button type="submit" class="w-full" :disabled="busy || !username || !password">
            <Loader2 v-if="busy" class="size-4 animate-spin" />
            Anmelden
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
