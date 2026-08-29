<script setup lang="ts">
import { computed, ref } from 'vue';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import PagedTable from '@/components/PagedTable.vue';
import { useSelectionStore } from '@/stores/selection';
import { api, type Agent } from '@/api';
import { isValidDisplayName, nameComplaint } from '@/naming';
import { AGENT_STREAM_CEILING } from '@/player/tile-state';

/**
 * The agents at the selected site: what each is carrying, and whether it is
 * anywhere near what it can carry.
 *
 * The capacity column is the point of this page. An agent's real limit is its
 * CPU, memory, disk and uplink, and it will reach those long before the hard
 * ceiling — so the number is shown as a proportion with the ceiling named,
 * and the warning arrives while there is still room to act on it.
 */
const selection = useSelectionStore();
/** Only the refresh handle is needed, and naming it avoids depending on the
 * instance type of a generic component. */
const table = ref<{ refresh: () => Promise<void> } | null>(null);

const newName = ref('');
const creating = ref(false);
const createError = ref<string | null>(null);

const load = (params: { q?: string; cursor?: string; limit: number }) =>
  api.agents({
    tenantId: selection.tenantParam,
    premisesId: selection.premisesId!,
    ...params,
  });

const resetOn = computed(() => [selection.customerId, selection.premisesId]);

const complaint = computed(() => (newName.value ? nameComplaint(newName.value) : null));

/** How full an agent is, as a fraction of the hard ceiling. */
function load_(agent: Agent) {
  return agent.cameraCount / AGENT_STREAM_CEILING;
}

function severity(agent: Agent) {
  const fraction = load_(agent);
  if (fraction >= 1) return 'danger';
  if (fraction >= 0.8) return 'warn';
  return 'secondary';
}

function capacityNote(agent: Agent): string | null {
  const fraction = load_(agent);
  if (fraction >= 1) {
    return `At the ceiling of ${AGENT_STREAM_CEILING} cameras. Add another agent at this site.`;
  }
  if (fraction >= 0.8) {
    return `Approaching the ceiling of ${AGENT_STREAM_CEILING} cameras. `
      + 'How many it can actually stream at once depends on its CPU, memory and uplink.';
  }
  return null;
}

/**
 * An agent that is connected and still does not know about cameras it has been
 * given. Worth saying: it looks like a working agent with missing cameras, and
 * the cause is that it has not picked up the assignment.
 */
function laggingNote(agent: Agent): string | null {
  if (!agent.online || agent.reportedCameras === undefined) return null;
  const behind = agent.cameraCount - agent.reportedCameras;
  if (behind <= 0) return null;
  return `Connected, but has only picked up ${agent.reportedCameras} of them so far.`;
}

async function create() {
  if (!isValidDisplayName(newName.value) || !selection.premisesId) return;
  creating.value = true;
  createError.value = null;
  try {
    await api.createAgent({
      displayName: newName.value.trim(),
      premisesId: selection.premisesId,
      tenantId: selection.tenantParam,
    });
    newName.value = '';
    await table.value?.refresh();
    await selection.loadAgents();
  } catch (err) {
    createError.value = (err as Error).message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div>
    <div class="page-head"><h1>Agents</h1></div>

    <p v-if="!selection.ready" class="empty">Choose a premises on the left to begin.</p>

    <template v-else>
      <form class="create" @submit.prevent="create">
        <InputText
          v-model="newName"
          placeholder="New agent name"
          :invalid="Boolean(complaint)"
          aria-label="New agent name"
        />
        <Button
          type="submit" label="Add agent" size="small"
          :loading="creating" :disabled="!isValidDisplayName(newName)"
        />
        <span v-if="complaint" class="create__hint">{{ complaint }}</span>
      </form>

      <Message v-if="createError" severity="error" size="small" variant="simple">
        {{ createError }}
      </Message>

      <PagedTable
        ref="table"
          :load="load"
        :reset-on="resetOn"
        row-key="thingName"
        search-label="agent names"
      >
        <Column header="Name">
          <template #body="{ data }">{{ data.siteName || data.thingName }}</template>
        </Column>
        <Column header="Connected">
          <template #body="{ data }">
            <Tag
              :value="data.online ? 'online' : 'offline'"
              :severity="data.online ? 'success' : 'danger'"
            />
          </template>
        </Column>
        <Column header="Cameras">
          <template #body="{ data }">
            <span class="cap">
              <Tag :value="`${data.cameraCount} / ${AGENT_STREAM_CEILING}`" :severity="severity(data)" />
              <span v-if="capacityNote(data)" class="cap__note">{{ capacityNote(data) }}</span>
              <span v-else-if="laggingNote(data)" class="cap__note">{{ laggingNote(data) }}</span>
            </span>
          </template>
        </Column>
        <Column header="Converting">
          <template #body="{ data }">
            {{ data.maxConcurrentTranscodes }} at a time
          </template>
        </Column>
        <Column field="agentVersion" header="Version">
          <template #body="{ data }">{{ data.agentVersion ?? '—' }}</template>
        </Column>
        <Column header="Health">
          <template #body="{ data }">
            <span v-if="!data.health" class="muted">no report</span>
            <Tag
              v-else-if="data.health.healthy"
              :value="`${data.health.publishing} publishing`" severity="success"
            />
            <Tag v-else :value="`${data.health.failingTasks.length} failing`" severity="danger" />
          </template>
        </Column>
      </PagedTable>
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

.create__hint,
.cap__note,
.muted {
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
}

.cap {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cap__note {
  max-width: 22rem;
  line-height: 1.35;
}
</style>
