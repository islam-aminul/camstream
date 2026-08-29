<script setup lang="ts">
import BrandMark from '@/components/BrandMark.vue';
import { ref } from 'vue';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { signIn, completeNewPassword, NewPasswordRequired } from '@/api/auth';
import type { CognitoUser } from 'amazon-cognito-identity-js';

defineProps<{ notice: string | null }>();
const emit = defineEmits<{ signedIn: [] }>();

const email = ref('');
const password = ref('');
const newPassword = ref('');
const pending = ref<CognitoUser | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

async function submit() {
  busy.value = true;
  error.value = null;
  try {
    if (pending.value) {
      await completeNewPassword(pending.value, newPassword.value);
    } else {
      await signIn(email.value.trim(), password.value);
    }
    emit('signedIn');
  } catch (err) {
    if (err instanceof NewPasswordRequired) {
      // An admin-created account arrives here on its first sign-in.
      pending.value = err.user;
      error.value = null;
    } else {
      error.value = (err as Error).message ?? 'Could not sign in';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="centre">
    <form class="card" @submit.prevent="submit">
      <h1><BrandMark label="CamStream" /> CamStream</h1>

      <Message v-if="notice" severity="warn" size="small" variant="simple">{{ notice }}</Message>
      <Message v-if="error" severity="error" size="small" variant="simple">{{ error }}</Message>

      <template v-if="!pending">
        <label for="email">Email</label>
        <InputText id="email" v-model="email" type="email" autocomplete="username" fluid required />

        <label for="password">Password</label>
        <Password
          id="password" v-model="password" :feedback="false" toggle-mask
          input-id="password" autocomplete="current-password" fluid required
        />
      </template>

      <template v-else>
        <p class="card__note">Choose a password to finish setting up this account.</p>
        <label for="new-password">New password</label>
        <Password
          id="new-password" v-model="newPassword" toggle-mask
          input-id="new-password" autocomplete="new-password" fluid required
        />
      </template>

      <Button type="submit" :loading="busy" :label="pending ? 'Set password' : 'Sign in'" fluid />
    </form>
  </div>
</template>

<style scoped>
.centre {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 1rem;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  width: min(22rem, 100%);
  padding: 1.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
}

h1 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
  letter-spacing: -0.02em;
}

label {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.card__note {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

h1 {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: var(--p-primary-color);
}
</style>
