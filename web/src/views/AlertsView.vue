<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import ProgressBar from 'primevue/progressbar';
import { api, type AlertRecipient } from '@/api';
import { useSessionStore } from '@/stores/session';

/**
 * Who is emailed when this deployment starts failing.
 *
 * These alarms are about the control plane — a wedged function, a throttled
 * table, no agent heartbeats anywhere — and not about any one customer's
 * cameras, which is why only the platform operator sees this page.
 *
 * It exists because the address used to be a deploy-time value. Changing who
 * is on call meant running a CDK deploy: impossible for somebody holding a
 * phone at midnight, and it put a shared mailbox in a public repository.
 */
const session = useSessionStore();
const permitted = computed(() => session.me?.role === 'superadmin');

const recipients = ref<AlertRecipient[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const draft = ref('');
const adding = ref(false);
const removing = ref<string | null>(null);

/** Loose on purpose: the confirmation email is the real test of an address. */
const looksLikeEmail = computed(() => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(draft.value.trim()));

async function load() {
  if (!permitted.value) return;
  loading.value = true;
  error.value = null;
  try {
    recipients.value = (await api.alertRecipients()).recipients;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function add() {
  if (!looksLikeEmail.value) return;
  adding.value = true;
  error.value = null;
  notice.value = null;
  try {
    const email = draft.value.trim();
    await api.addAlertRecipient(email);
    draft.value = '';
    notice.value = `AWS has emailed ${email} a confirmation link. `
      + 'Nothing is delivered to it until somebody clicks that link.';
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    adding.value = false;
  }
}

async function remove(recipient: AlertRecipient) {
  removing.value = recipient.arn;
  error.value = null;
  notice.value = null;
  try {
    await api.removeAlertRecipient(recipient.arn);
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    removing.value = null;
  }
}

/**
 * A pending subscription cannot be removed through the API — it has no ARN
 * until it is confirmed, and AWS expires it by itself after three days.
 */
const canRemove = (recipient: AlertRecipient) => recipient.confirmed;

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head"><h1>Alerts</h1></div>

    <p v-if="!permitted" class="empty">
      These alarms are about the platform itself, so only the platform operator
      manages who receives them.
    </p>

    <template v-else>
      <p class="lede">
        Who is emailed when this deployment starts failing — functions erroring or
        being throttled, the registry refusing writes, or no agent heartbeating
        anywhere. Not camera outages: those belong to the customer whose camera
        it is.
      </p>

      <div class="add">
        <InputText
          v-model="draft"
          placeholder="alerts@example.com"
          :invalid="draft.length > 0 && !looksLikeEmail"
          class="add__input"
          @keyup.enter="add()"
        />
        <Button
          v-tooltip.top="'AWS sends a confirmation link before anything is delivered'"
          label="Add" :loading="adding" :disabled="!looksLikeEmail" @click="add()"
        />
        <Button
          v-tooltip.top="'Fetch the current list from SNS'"
          icon="pi pi-refresh" text severity="secondary" aria-label="Reload"
          :loading="loading" @click="load()"
        />
      </div>

      <Message v-if="notice" severity="info" size="small" closable @close="notice = null">
        {{ notice }}
      </Message>
      <Message v-if="error" severity="error" size="small" variant="simple">{{ error }}</Message>

      <ProgressBar v-if="loading" mode="indeterminate" class="thin" />

      <p v-else-if="!recipients.length" class="empty">
        Nobody is subscribed. Every alarm this deployment raises would fire into
        silence, and the first report would come from a customer.
      </p>

      <ul v-else class="recipients">
        <li v-for="recipient in recipients" :key="recipient.arn || recipient.endpoint">
          <span class="recipients__who">{{ recipient.endpoint }}</span>
          <Tag
            v-tooltip.top="recipient.confirmed
              ? 'Confirmed — alarms are delivered here'
              : 'AWS is waiting for this address to click the confirmation link. Nothing is delivered until it does, and the invitation expires after three days.'"
            :value="recipient.confirmed ? 'confirmed' : 'awaiting confirmation'"
            :severity="recipient.confirmed ? 'success' : 'warn'"
          />
          <Button
            v-tooltip.left="canRemove(recipient)
              ? 'Stop sending alarms to this address'
              : 'An unconfirmed invitation has no identifier to remove. AWS expires it after three days.'"
            size="small" text severity="danger" icon="pi pi-trash"
            :aria-label="`Remove ${recipient.endpoint}`"
            :disabled="!canRemove(recipient)"
            :loading="removing === recipient.arn"
            @click="remove(recipient)"
          />
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.lede {
  margin: 0 0 1rem;
  max-width: 46rem;
  font-size: 0.84rem;
  line-height: 1.5;
  color: var(--p-text-muted-color);
}

.add {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.9rem;
}

.add__input {
  width: 20rem;
}

.thin {
  height: 3px;
}

.recipients {
  list-style: none;
  margin: 0;
  padding: 0;
  max-width: 40rem;
}

.recipients li {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.2rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.recipients__who {
  flex: 1;
  font-size: 0.88rem;
}
</style>
