<script setup lang="ts">
import { Eye, EyeOff, Loader2, ShieldAlert } from '@lucide/vue';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import { setup } from '@/auth';
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

const router = useRouter();

const username = ref('');
const password = ref('');
const repeat = ref('');
const visible = ref(false);
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
  <div class="flex min-h-screen items-center justify-center px-5 py-10">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Einrichtung</CardTitle>
        <CardDescription>
          Es existiert noch kein Benutzer. Dieses Konto wird das Administratorkonto.
        </CardDescription>
      </CardHeader>

      <CardContent class="space-y-4">
        <Alert class="border-warning/40">
          <ShieldAlert class="size-4" />
          <AlertDescription>
            Solange die Einrichtung offen ist, kann sie jeder abschliessen, der diese Seite
            erreicht. Bitte jetzt durchführen.
          </AlertDescription>
        </Alert>

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
                autocomplete="new-password"
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
            <p class="text-muted-foreground text-xs">Mindestens 12 Zeichen.</p>
          </div>

          <div class="space-y-1.5">
            <Label for="repeat">Passwort wiederholen</Label>
            <Input
              id="repeat"
              v-model="repeat"
              :type="visible ? 'text' : 'password'"
              autocomplete="new-password"
            />
          </div>

          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <Button type="submit" class="w-full" :disabled="busy || !username || !password">
            <Loader2 v-if="busy" class="size-4 animate-spin" />
            Einrichtung abschliessen
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
