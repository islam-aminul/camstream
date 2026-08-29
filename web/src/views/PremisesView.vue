<script setup lang="ts">
import { ref, computed } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import ConfirmDialog from 'primevue/confirmdialog';
import { useConfirm } from 'primevue/useconfirm';
import { useSelectionStore } from '@/stores/selection';
import { api } from '@/api';
import { isValidDisplayName, nameComplaint, idFrom } from '@/naming';

/**
 * The sites of the selected customer.
 *
 * Not paged: a hundred premises is the scale this is sold at, and the rail
 * already holds the whole list to populate its own dropdown. Paging a list
 * that is already in memory would be furniture rather than function.
 *
 * The id is shown while a name is being typed, because it is permanent and
 * ends up in URLs, thing names and S3 paths — somebody naming a site should
 * see what they are actually naming.
 */
const selection = useSelectionStore();
const confirm = useConfirm();

const displayName = ref('');
const address = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const complaint = computed(() => (displayName.value ? nameComplaint(displayName.value) : null));
const preview = computed(() => (isValidDisplayName(displayName.value)
  ? idFrom(displayName.value) : null));

async function create() {
  if (!isValidDisplayName(displayName.value)) return;
  busy.value = true;
  error.value = null;
  try {
    await api.createPremises({
      displayName: displayName.value.trim(),
      address: address.value.trim() || undefined,
      tenantId: selection.tenantParam,
    });
    displayName.value = '';
    address.value = '';
    await selection.loadPremises();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

function remove(premisesId: string, name: string) {
  confirm.require({
    header: 'Delete this site?',
    message: `"${name}" and everything registered at it — agents, cameras and stored `
      + 'credentials — stop being reachable. This cannot be undone.',
    acceptLabel: 'Delete',
    rejectLabel: 'Keep',
    acceptProps: { severity: 'danger' },
    accept: async () => {
      busy.value = true;
      error.value = null;
      try {
        await api.deletePremises(premisesId);
        await selection.loadPremises();
      } catch (err) {
        error.value = (err as Error).message;
      } finally {
        busy.value = false;
      }
    },
  });
}
</script>

<template>
  <div>
    <ConfirmDialog />
    <div class="page-head"><h1>Premises</h1></div>

    <p v-if="!selection.customerId" class="empty">Choose a customer on the left to begin.</p>

    <template v-else>
      <form class="create" @submit.prevent="create">
        <InputText
          v-model="displayName" placeholder="Site name"
          :invalid="Boolean(complaint)" aria-label="Site name"
        />
        <InputText v-model="address" placeholder="Address (optional)" aria-label="Address" />
        <Button
          type="submit" label="Add site" size="small"
          :loading="busy" :disabled="!isValidDisplayName(displayName)"
        />
        <span v-if="complaint" class="hint hint--bad">{{ complaint }}</span>
        <span v-else-if="preview" class="hint">Will be known as <code>{{ preview }}</code></span>
      </form>

      <Message v-if="error" severity="error" size="small" variant="simple">{{ error }}</Message>

      <DataTable :value="selection.premises" data-key="premisesId" size="small" striped-rows>
        <Column field="displayName" header="Name" />
        <Column field="premisesId" header="Id">
          <template #body="{ data }"><code>{{ data.premisesId }}</code></template>
        </Column>
        <Column field="address" header="Address">
          <template #body="{ data }">{{ data.address || '—' }}</template>
        </Column>
        <Column header="" style="width: 5rem">
          <template #body="{ data }">
            <Button
              size="small" text severity="danger" icon="pi pi-trash"
              :aria-label="`Delete ${data.displayName}`"
              @click="remove(data.premisesId, data.displayName)"
            />
          </template>
        </Column>
        <template #empty>
          <p class="empty">No sites yet. Add the first one above.</p>
        </template>
      </DataTable>
    </template>
  </div>
</template>

<style scoped>
.create {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.hint {
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
}

.hint--bad {
  color: var(--p-red-400);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.76rem;
}
</style>
