<script setup lang="ts">
import { computed, ref } from 'vue';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Message from 'primevue/message';
import PagedTable from '@/components/PagedTable.vue';
import WhenAgo from '@/components/WhenAgo.vue';
import { useSelectionStore } from '@/stores/selection';
import { api, type Camera } from '@/api';
import { nameComplaint } from '@/naming';
import { useRoute, useRouter } from 'vue-router';

/**
 * Every camera at the selected site, filtered by the rail.
 *
 * The rail already narrows to a customer, a site and optionally an agent, so
 * this page adds only what the rail cannot express: a search within the
 * narrowing, the state of each camera, and the one piece of a camera an
 * operator owns — its name.
 */
const selection = useSelectionStore();
const router = useRouter();
const route = useRoute();

const load = (params: { q?: string; cursor?: string; limit: number }) =>
  api.cameras({
    tenantId: selection.tenantParam,
    premisesId: selection.premisesId!,
    agentId: selection.agentId ?? undefined,
    ...params,
  });

/** Changing any of these makes every held cursor meaningless. */
const resetOn = computed(() => [
  selection.customerId, selection.premisesId, selection.agentId,
]);

/** Bumped after a rename so the table refetches and shows the new name. */
const reloadKey = ref(0);

/**
 * Watching one camera is the rail's camera level plus the live view.
 *
 * Navigate first, then set the selection. The other order looked natural and
 * did not work: assigning to the store wakes the rail's URL watcher, which
 * replaces the current location to record the camera, and that replace landed
 * after the push and cancelled it. The button added `camera=` to the address
 * bar and left you on this page — doing something visible, but not the thing
 * it said. With the navigation already applied, the watcher's replace writes
 * the same query onto the page it is now on, and is a no-op.
 */
async function watchIt(camera: Camera) {
  await router.push({
    name: 'live',
    query: { ...route.query, camera: camera.cameraId },
  });
  selection.cameraId = camera.cameraId;
}

// ------------------------------------------------------------------ renaming

const renaming = ref<Camera | null>(null);
const draft = ref('');
const saving = ref(false);
const failed = ref<string | null>(null);

/** The same rule the server enforces, so a bad name is refused before the trip. */
const complaint = computed(() => nameComplaint(draft.value));

function beginRename(camera: Camera) {
  renaming.value = camera;
  // Prefilled unless the current name is the identity it was approved under,
  // which is the case this exists for: retyping a MAC address to replace it
  // is not a starting point anybody wants.
  draft.value = camera.displayName === camera.identity ? '' : camera.displayName;
  failed.value = null;
}

async function saveRename() {
  const camera = renaming.value;
  if (!camera || complaint.value) return;
  saving.value = true;
  failed.value = null;
  try {
    await api.renameCamera(camera.identity, {
      displayName: draft.value.trim(),
      premisesId: selection.premisesId!,
      tenantId: selection.tenantParam,
    });
    renaming.value = null;
    reloadKey.value += 1;
    // The rail holds its own copy of the camera list and labels the dropdown
    // from it, so without this the name changes in the table and the sidebar
    // goes on showing the hardware address until the next reload.
    await selection.loadCameras();
  } catch (err) {
    failed.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

// ------------------------------------------------------------------- moving

/**
 * Moving a camera to another agent at the same site, optionally exchanging it
 * for one of that agent's.
 *
 * The exchange is why this posts a list rather than a single camera. Done as
 * two requests the first would land, the second could be refused for
 * reachability, and both cameras would end up on one agent — a state nobody
 * asked for, arrived at half way through an operation that looked atomic.
 */
const moving = ref<Camera | null>(null);
const targetAgent = ref<string | null>(null);
const swapWith = ref<string | null>(null);
const targetCameras = ref<Camera[]>([]);
const loadingTarget = ref(false);
const movingNow = ref(false);
const moveFailed = ref<string | null>(null);

/** Every other agent at this site. A camera cannot move to where it already is. */
const agentChoices = computed(() => selection.agents
  .filter((agent) => agent.thingName !== moving.value?.assignedTo)
  .map((agent) => ({
    value: agent.thingName,
    label: agent.siteName || agent.thingName,
    hint: agent.online ? 'online' : 'offline',
  })));

const swapChoices = computed(() => targetCameras.value.map((camera) => ({
  value: camera.identity,
  label: camera.displayName || camera.cameraId,
})));

function beginMove(camera: Camera) {
  moving.value = camera;
  targetAgent.value = null;
  swapWith.value = null;
  targetCameras.value = [];
  moveFailed.value = null;
}

/** What the chosen agent already carries, so one of them can be sent back. */
async function loadTargetCameras(thingName: string | null) {
  swapWith.value = null;
  targetCameras.value = [];
  if (!thingName) return;
  loadingTarget.value = true;
  try {
    const page = await api.cameras({
      tenantId: selection.tenantParam,
      premisesId: selection.premisesId!,
      agentId: thingName,
      limit: 200,
    });
    targetCameras.value = page.items;
  } catch (err) {
    moveFailed.value = (err as Error).message;
  } finally {
    loadingTarget.value = false;
  }
}

async function saveMove() {
  const camera = moving.value;
  const to = targetAgent.value;
  if (!camera || !to) return;
  movingNow.value = true;
  moveFailed.value = null;
  try {
    const moves = [{ identity: camera.identity, assignedTo: to }];
    if (swapWith.value) {
      moves.push({ identity: swapWith.value, assignedTo: camera.assignedTo });
    }
    await api.moveCameras({
      moves, premisesId: selection.premisesId!, tenantId: selection.tenantParam,
    });
    moving.value = null;
    reloadKey.value += 1;
    await selection.loadCameras();
  } catch (err) {
    moveFailed.value = (err as Error).message;
  } finally {
    movingNow.value = false;
  }
}

/** A camera still carrying the identity it was approved under has no name. */
const isUnnamed = (camera: Camera) => camera.displayName === camera.identity;
</script>

<template>
  <div>
    <div class="page-head"><h1>Cameras</h1></div>

    <p v-if="!selection.ready" class="empty">Choose a premises on the left to begin.</p>

    <PagedTable
      v-else
      :key="reloadKey"
      :load="load"
      :reset-on="resetOn"
      row-key="identity"
      search-label="camera names"
    >
      <Column header="Name">
        <template #body="{ data }">
          <span :class="{ unnamed: isUnnamed(data) }">{{ data.displayName }}</span>
          <span
            v-if="isUnnamed(data)"
            v-tooltip.right="'Registered under its hardware address, because the camera told the agent nothing about itself. Rename it to something you will recognise on the wall.'"
            class="unnamed__flag"
          >needs a name</span>
        </template>
      </Column>
      <Column field="cameraId" header="Id" />
      <Column header="Agent">
        <template #body="{ data }">
          <span class="mono">{{ data.assignedTo }}</span>
        </template>
      </Column>
      <Column header="In service">
        <template #body="{ data }">
          <WhenAgo :at="data.approvedAt" absent="unknown" />
        </template>
      </Column>
      <Column field="sourceCodec" header="Codec">
        <template #body="{ data }">{{ data.sourceCodec ?? '—' }}</template>
      </Column>
      <Column header="State">
        <template #body="{ data }">
          <Tag
            v-tooltip.left="data.publishing ? 'An agent is publishing this camera right now' : 'Registered, but nobody is watching it. Streams start on demand.'"
            :value="data.publishing ? 'publishing' : 'idle'"
            :severity="data.publishing ? 'success' : 'secondary'"
          />
        </template>
      </Column>
      <Column header="" style="width: 11rem">
        <template #body="{ data }">
          <Button
            v-tooltip.top="'Rename this camera'"
            size="small" text severity="secondary" icon="pi pi-pencil"
            aria-label="Rename this camera" @click="beginRename(data)"
          />
          <Button
            v-tooltip.top="'Move this camera to another agent, or swap it with one of theirs'"
            size="small" text severity="secondary" icon="pi pi-arrow-right-arrow-left"
            aria-label="Move this camera to another agent"
            :disabled="selection.agents.length < 2"
            @click="beginMove(data)"
          />
          <Button
            v-tooltip.top="'Open this camera on the live wall'"
            size="small" text label="Watch" @click="watchIt(data)"
          />
        </template>
      </Column>
    </PagedTable>

    <Dialog
      :visible="renaming !== null" modal header="Rename camera" :style="{ width: '26rem' }"
      @update:visible="renaming = null"
    >
      <p class="dialog__what"><span class="mono">{{ renaming?.identity }}</span></p>
      <InputText
        v-model="draft" fluid autofocus placeholder="Front Gate"
        :invalid="draft.length > 0 && complaint !== null"
        @keyup.enter="saveRename()"
      />
      <p v-if="draft.length > 0 && complaint" class="dialog__complaint">{{ complaint }}</p>
      <p v-else class="dialog__hint">Letters, digits, single spaces and single hyphens.</p>

      <Message v-if="failed" severity="error" size="small" variant="simple">{{ failed }}</Message>

      <template #footer>
        <Button label="Cancel" text severity="secondary" @click="renaming = null" />
        <Button label="Rename" :loading="saving" :disabled="complaint !== null" @click="saveRename()" />
      </template>
    </Dialog>
    <Dialog
      :visible="moving !== null" modal header="Move camera" :style="{ width: '28rem' }"
      @update:visible="moving = null"
    >
      <p class="dialog__what">
        <strong>{{ moving?.displayName }}</strong>
        is published by <span class="mono">{{ moving?.assignedTo }}</span>.
      </p>

      <div class="stack">
        <label for="move-agent">Move it to</label>
        <Select
          id="move-agent" v-model="targetAgent" :options="agentChoices"
          option-label="label" option-value="value" placeholder="Choose an agent" fluid
          @update:model-value="loadTargetCameras($event)"
        />

        <template v-if="targetAgent">
          <label for="move-swap">And send back (optional)</label>
          <Select
            id="move-swap" v-model="swapWith" :options="swapChoices"
            option-label="label" option-value="value" show-clear
            :loading="loadingTarget"
            :placeholder="swapChoices.length ? 'Nothing — just move it' : 'That agent has no cameras'"
            :disabled="!swapChoices.length" fluid
          />
          <p class="dialog__hint">
            Choosing one exchanges the two cameras. Both moves are applied together
            or not at all, so they cannot both end up on one agent.
          </p>
        </template>
      </div>

      <Message v-if="moveFailed" severity="error" size="small" variant="simple">{{ moveFailed }}</Message>

      <template #footer>
        <Button label="Cancel" text severity="secondary" @click="moving = null" />
        <Button
          :label="swapWith ? 'Swap' : 'Move'" :loading="movingNow"
          :disabled="!targetAgent" @click="saveMove()"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.76rem;
  color: var(--p-text-muted-color);
}

/* A camera registered under its hardware address is not really named. It is
   shown as it is, but marked, because the fix is one click away. */
.unnamed {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}

.unnamed__flag {
  margin-left: 0.45rem;
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  font-size: 0.64rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  cursor: help;
}

.dialog__what {
  margin: 0 0 0.6rem;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.stack label {
  margin-top: 0.4rem;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.dialog__complaint,
.dialog__hint {
  margin: 0.35rem 0 0;
  font-size: 0.72rem;
  line-height: 1.35;
}

.dialog__complaint {
  color: var(--p-red-500);
}

.dialog__hint {
  color: var(--p-text-muted-color);
}
</style>
