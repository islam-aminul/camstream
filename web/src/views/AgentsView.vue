<script setup lang="ts">
import { computed, ref } from 'vue';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import InputNumber from 'primevue/inputnumber';
import Message from 'primevue/message';
import PagedTable from '@/components/PagedTable.vue';
import { updateRefusal as refusalFor } from '@/agent-update';
import WhenAgo from '@/components/WhenAgo.vue';
import ClockDrift from '@/components/ClockDrift.vue';
import { useSelectionStore } from '@/stores/selection';
import { api, type Agent, type Platform } from '@/api';
import { isValidDisplayName, nameComplaint } from '@/naming';
import { AGENT_STREAM_CEILING, MAX_TRANSCODE_CAP } from '@/player/tile-state';

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
const upgrading = ref<string | null>(null);

/**
 * Tells an agent to fetch the current build and restart into it.
 *
 * The platform is the agent's, not this browser's; it is not recorded, so it
 * is asked for. A wrong answer is refused by the agent rather than installed.
 */
async function upgrade(agent: Agent, platform: Platform) {
  upgrading.value = agent.thingName;
  createError.value = null;
  try {
    const result = await api.upgradeAgent(agent.thingName, platform);
    notice.value = `Asked ${agent.siteName || agent.thingName} to install ${result.version}. `
      + 'It restarts itself, and reappears here within a minute or two.';
  } catch (err) {
    createError.value = (err as Error).message;
  } finally {
    upgrading.value = null;
  }
}

/**
 * How many cameras an agent may convert at once.
 *
 * A conversion is a full re-encode - roughly a core per 1080p stream - where
 * an ordinary camera is a stream copy, so this is the one number on this page
 * that decides whether the machine at the site keeps up. It was previously
 * only displayed, which meant the only way to change it was a hand-rolled API
 * call with a token lifted out of devtools.
 *
 * The agent applies its own resource ceiling underneath whatever is set here,
 * so this is a statement of intent rather than a promise: ask for eight on a
 * machine that can carry two and it will carry two, and go back to eight if
 * the machine is ever able to.
 */
const editingCap = ref<string | null>(null);
const capDraft = ref<number | null>(null);
const savingCap = ref(false);

function beginCap(agent: Agent) {
  editingCap.value = agent.thingName;
  capDraft.value = agent.maxConcurrentTranscodes;
  createError.value = null;
}

async function saveCap(agent: Agent) {
  const wanted = capDraft.value;
  if (wanted === null || !Number.isInteger(wanted) || wanted < 0 || wanted > MAX_TRANSCODE_CAP) {
    createError.value = `Choose a whole number between 0 and ${MAX_TRANSCODE_CAP}.`;
    return;
  }
  savingCap.value = true;
  createError.value = null;
  try {
    await api.setTranscodeCap(agent.thingName, wanted);
    editingCap.value = null;
    notice.value = `${agent.siteName || agent.thingName} will convert `
      + `${wanted === 0 ? 'nothing' : `up to ${wanted} camera${wanted === 1 ? '' : 's'}`} at a time.`;
    await table.value?.refresh();
  } catch (err) {
    createError.value = (err as Error).message;
  } finally {
    savingCap.value = false;
  }
}

const notice = ref<string | null>(null);
const platform = ref<Platform>('windows');
const creating = ref(false);
const createError = ref<string | null>(null);

/**
 * The build an Update would install, as the control plane last reported it.
 *
 * Null until a page has loaded, and treated as "unknown" rather than "not
 * current" - offering an Update that may be needed is better than hiding one
 * that is.
 */
const currentVersion = ref<string | null>(null);

const load = (params: { q?: string; cursor?: string; limit: number }) =>
  api.agents({
    tenantId: selection.tenantParam,
    premisesId: selection.premisesId!,
    ...params,
  }).then((page) => {
    currentVersion.value = page.currentVersion ?? null;
    return page;
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
 * What the machine is short of, if anything.
 *
 * The agent decides this — it is the only thing that can see its own processor,
 * memory, disk and uplink — and sends a sentence rather than thresholds, so the
 * console does not re-derive a judgement made with better information.
 */
function constraintOf(agent: Agent): { label: string; message: string } | null {
  const health = agent.health;
  if (!health || !health.constraint || health.constraint === 'none') return null;
  const label = {
    cpu: 'processor', memory: 'memory', disk: 'disk', uplink: 'connection',
  }[health.constraint] ?? health.constraint;
  return { label, message: health.constraintMessage ?? '' };
}

/** Headroom on a machine that is coping, so the edge is visible before it bites. */
function headroom(agent: Agent): string | null {
  const r = agent.health?.resources;
  if (!r) return null;
  const parts: string[] = [];
  if (r.cpuLoad !== null && r.cpuLoad !== undefined) {
    parts.push(`CPU ${Math.round(r.cpuLoad * 100)}%`);
  }
  if (r.memoryUsedFraction !== null && r.memoryUsedFraction !== undefined) {
    parts.push(`memory ${Math.round(r.memoryUsedFraction * 100)}%`);
  }
  if (r.diskFreeBytes !== null && r.diskFreeBytes !== undefined) {
    parts.push(`${(r.diskFreeBytes / 1024 ** 3).toFixed(1)} GB free`);
  }
  if (r.uploadBytesPerSecond !== null && r.uploadBytesPerSecond !== undefined
      && r.uploadBytesPerSecond > 0) {
    parts.push(`${(r.uploadBytesPerSecond * 8 / 1e6).toFixed(1)} Mbps up`);
  }
  return parts.length ? parts.join(' · ') : null;
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
      siteName: newName.value.trim(),
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
          v-tooltip.top="'Enrol a new agent at this site. You install it on the machine afterwards.'"
          type="submit" label="Add agent" size="small"
          :loading="creating" :disabled="!isValidDisplayName(newName)"
        />
        <span v-if="complaint" class="create__hint">{{ complaint }}</span>

        <Select
          v-model="platform" :options="['linux', 'windows']"
          size="small" aria-label="Agent platform"
        />
        <span class="create__hint">
          The platform "Update" installs for. It is not recorded per agent, and an agent
          refuses a build that is not its own.
        </span>
      </form>

      <Message v-if="createError" severity="error" size="small" variant="simple">
        {{ createError }}
      </Message>
      <Message v-if="notice" severity="info" size="small" variant="simple">{{ notice }}</Message>

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
        <Column header="Transcoding" style="width: 13rem">
          <template #body="{ data }">
            <span v-if="editingCap === data.thingName" class="cap-edit">
              <InputNumber
                v-model="capDraft" :min="0" :max="MAX_TRANSCODE_CAP" :step="1"
                show-buttons button-layout="horizontal" input-class="cap-edit__input"
                increment-button-icon="pi pi-plus" decrement-button-icon="pi pi-minus"
                @keyup.enter="saveCap(data)"
              />
              <Button
                v-tooltip.top="'Save'"
                size="small" text icon="pi pi-check" aria-label="Save"
                :loading="savingCap" @click="saveCap(data)"
              />
              <Button
                v-tooltip.top="'Cancel'"
                size="small" text severity="secondary" icon="pi pi-times" aria-label="Cancel"
                @click="editingCap = null"
              />
            </span>
            <button
              v-else
              v-tooltip.top="`How many cameras this agent may re-encode at once, 0 to ${MAX_TRANSCODE_CAP}. The machine's own limit applies underneath.`"
              type="button" class="cap-edit__open" @click="beginCap(data)"
            >
              {{ data.maxConcurrentTranscodes === 0 ? 'none' : `${data.maxConcurrentTranscodes} at a time` }}
              <i class="pi pi-pencil" aria-hidden="true" />
            </button>
          </template>
        </Column>
        <Column header="Last report">
          <template #body="{ data }">
            <WhenAgo :at="data.lastSeen" absent="never checked in" />
          </template>
        </Column>
        <Column header="Clock">
          <template #body="{ data }">
            <ClockDrift :seconds="data.clockSkewSeconds" />
          </template>
        </Column>
        <Column field="agentVersion" header="Version">
          <template #body="{ data }">{{ data.agentVersion ?? '—' }}</template>
        </Column>
        <Column header="" style="width: 8rem">
          <template #body="{ data }">
            <Button
              v-tooltip.top="refusalFor(data, currentVersion)
                ?? 'Tell this agent to fetch the current build and restart into it'"
              size="small" text severity="secondary" label="Update"
              :loading="upgrading === data.thingName"
              :disabled="refusalFor(data, currentVersion) !== null"
              :title="refusalFor(data, currentVersion) ?? 'Install the current build and restart'"
              @click="upgrade(data, platform)"
            />
          </template>
        </Column>
        <Column header="Health">
          <template #body="{ data }">
            <span v-if="!data.health" class="muted">no report</span>
            <template v-else>
              <Tag
                v-if="constraintOf(data)"
                :value="`${constraintOf(data)!.label} limited`" severity="warn"
              />
              <Tag
                v-else-if="data.health.healthy"
                :value="`${data.health.publishing} publishing`" severity="success"
              />
              <Tag v-else :value="`${data.health.failingTasks.length} failing`" severity="danger" />
              <!-- The sentence the agent sent, which names the limit and what
                   to do about it. This is the whole point of the telemetry. -->
              <p v-if="constraintOf(data)" class="cap__note">{{ constraintOf(data)!.message }}</p>
              <p v-else-if="headroom(data)" class="cap__note">{{ headroom(data) }}</p>
            </template>
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

.cap-edit {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}

:deep(.cap-edit__input) {
  width: 3.2rem;
  text-align: center;
}

/* Reads as text until it is hovered, so the column still scans as a column
   rather than as a row of form controls. */
.cap-edit__open {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0.35rem;
  margin-left: -0.35rem;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.cap-edit__open .pi {
  font-size: 0.7rem;
  opacity: 0;
  color: var(--p-text-muted-color);
}

.cap-edit__open:hover,
.cap-edit__open:focus-visible {
  border-color: var(--p-content-border-color);
}

.cap-edit__open:hover .pi,
.cap-edit__open:focus-visible .pi {
  opacity: 1;
}
</style>
