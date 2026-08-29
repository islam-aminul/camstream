<script setup lang="ts">
import { ref } from 'vue';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import ConfirmDialog from 'primevue/confirmdialog';
import { useConfirm } from 'primevue/useconfirm';
import PagedTable from '@/components/PagedTable.vue';
import { useSessionStore } from '@/stores/session';
import { useSelectionStore } from '@/stores/selection';
import { api, type Role, type User } from '@/api';

/**
 * The accounts of this customer.
 *
 * Paged like everything else, and for the same reason: five hundred users is
 * the scale this is sold at, and each row's role is its own call to the
 * identity provider. Reading them a page at a time is what keeps that call
 * count proportional to what is on screen.
 *
 * Roles are shown as a dropdown that saves on change rather than an edit
 * dialog. There is one field, changing it is the whole task, and a dialog
 * would be two more clicks around a single select.
 */
const session = useSessionStore();
const selection = useSelectionStore();
const confirm = useConfirm();
/** Only the refresh handle is needed, and naming it avoids depending on the
 * instance type of a generic component. */
const table = ref<{ refresh: () => Promise<void> } | null>(null);

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: 'superadmin', label: 'Superadmin', hint: 'Every customer' },
  { value: 'admin', label: 'Admin', hint: 'Manages this customer' },
  { value: 'operator', label: 'Operator', hint: 'Installs and configures cameras' },
  { value: 'viewer', label: 'Viewer', hint: 'Watches only' },
];

const email = ref('');
const role = ref<Role>('viewer');
const busy = ref(false);
const error = ref<string | null>(null);

const load = (params: { q?: string; cursor?: string; limit: number }) => api.users(params);

/** Only the platform operator may hand out the role that crosses customers. */
const grantable = () => (session.me?.role === 'superadmin'
  ? ROLES : ROLES.filter((r) => r.value !== 'superadmin'));

async function create() {
  const address = email.value.trim().toLowerCase();
  if (!address.includes('@')) return;
  busy.value = true;
  error.value = null;
  try {
    await api.createUser({ email: address, role: role.value, tenantId: selection.tenantParam });
    email.value = '';
    await table.value?.refresh();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function changeRole(user: User, next: Role) {
  error.value = null;
  try {
    await api.updateUser(user.username, { role: next });
    await table.value?.refresh();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

async function setEnabled(user: User, enabled: boolean) {
  error.value = null;
  try {
    await api.updateUser(user.username, { enabled });
    await table.value?.refresh();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

function remove(user: User) {
  confirm.require({
    header: 'Delete this account?',
    message: `${user.email} loses access immediately and cannot be restored. `
      + 'Disabling the account instead keeps its history and can be undone.',
    acceptLabel: 'Delete',
    rejectLabel: 'Keep',
    acceptProps: { severity: 'danger' },
    accept: async () => {
      error.value = null;
      try {
        await api.deleteUser(user.username);
        await table.value?.refresh();
      } catch (err) {
        error.value = (err as Error).message;
      }
    },
  });
}

/** Signing yourself out of your own console is not a click away by accident. */
const isSelf = (user: User) => user.email === session.me?.email;
</script>

<template>
  <div>
    <ConfirmDialog />
    <div class="page-head"><h1>Users</h1></div>

    <form class="create" @submit.prevent="create">
      <InputText
        v-model="email" type="email" placeholder="name@example.com" aria-label="Email address"
      />
      <Select
        v-model="role" :options="grantable()" option-label="label" option-value="value"
        aria-label="Role"
      />
      <Button
        type="submit" label="Invite" size="small"
        :loading="busy" :disabled="!email.includes('@')"
      />
      <span class="hint">They set their own password on first sign-in.</span>
    </form>

    <Message v-if="error" severity="error" size="small" variant="simple">{{ error }}</Message>

    <PagedTable
      ref="table"
      :load="load"
      row-key="username"
      search-label="email addresses"
    >
      <Column field="email" header="Email">
        <template #body="{ data }">
          {{ data.email }}
          <span v-if="isSelf(data)" class="hint">— you</span>
        </template>
      </Column>
      <Column header="Role" style="width: 12rem">
        <template #body="{ data }">
          <Select
            :model-value="data.role"
            :options="grantable()"
            option-label="label"
            option-value="value"
            :disabled="isSelf(data)"
            size="small"
            fluid
            :aria-label="`Role for ${data.email}`"
            @update:model-value="changeRole(data, $event)"
          />
        </template>
      </Column>
      <Column header="Sites">
        <template #body="{ data }">
          {{ data.premises || 'All sites' }}
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag
            v-if="!data.enabled" value="disabled" severity="danger"
          />
          <Tag
            v-else-if="data.status === 'FORCE_CHANGE_PASSWORD'"
            value="invited" severity="warn"
          />
          <Tag v-else value="active" severity="success" />
        </template>
      </Column>
      <Column header="" style="width: 9rem">
        <template #body="{ data }">
          <span v-if="!isSelf(data)" class="row-actions">
            <Button
              size="small" text severity="secondary"
              :label="data.enabled ? 'Disable' : 'Enable'"
              @click="setEnabled(data, !data.enabled)"
            />
            <Button
              size="small" text severity="danger" icon="pi pi-trash"
              :aria-label="`Delete ${data.email}`"
              @click="remove(data)"
            />
          </span>
        </template>
      </Column>
    </PagedTable>
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

.row-actions {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}
</style>
