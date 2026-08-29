<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import InputText from 'primevue/inputtext';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import Message from 'primevue/message';
import CascadeLevel from './CascadeLevel.vue';
import { useSelectionStore } from '@/stores/selection';
import { api } from '@/api';

/**
 * The selection rail: one component, every page.
 *
 * Customer sits above the three levels the console was specified with, and is
 * absent for anyone whose token pins them to one — which is every user but the
 * platform operator. A customer's own administrator sees exactly three
 * dropdowns and never learns the fourth exists.
 */
const selection = useSelectionStore();
const route = useRoute();
const router = useRouter();

const searchText = ref('');
const searching = ref(false);
const results = ref<Awaited<ReturnType<typeof api.search>> | null>(null);

const customerOptions = computed(() =>
  selection.customers.map((c) => ({ value: c.tenantId, label: c.displayName, hint: c.tenantId })));

const premisesOptions = computed(() =>
  selection.premises.map((p) => ({ value: p.premisesId, label: p.displayName, hint: p.address })));

const agentOptions = computed(() =>
  selection.agents.map((a) => ({
    value: a.thingName,
    label: a.siteName || a.thingName,
    hint: a.online ? `online · ${a.cameraCount} cameras` : 'offline',
  })));

const cameraOptions = computed(() =>
  selection.cameras.map((c) => ({
    value: c.cameraId,
    label: c.displayName,
    hint: c.publishing ? 'publishing' : undefined,
  })));

/**
 * The selection lives in the URL, so a view can be linked, reloaded and
 * bookmarked. Nearly free done from the start, and awkward to retrofit.
 */
watch(
  () => [selection.customerId, selection.premisesId, selection.agentId, selection.cameraId],
  () => {
    void router.replace({
      query: {
        ...route.query,
        customer: selection.customerIsPinned ? undefined : (selection.customerId ?? undefined),
        premises: selection.premisesId ?? undefined,
        agent: selection.agentId ?? undefined,
        camera: selection.cameraId ?? undefined,
      },
    });
  },
);

async function runSearch() {
  const q = searchText.value.trim();
  if (q.length < 2) { results.value = null; return; }
  searching.value = true;
  try {
    results.value = await api.search({ tenantId: selection.tenantParam, q });
  } finally {
    searching.value = false;
  }
}

/** Finding a camera by name has to leave the rail in a coherent state. */
async function jumpTo(target: { premisesId: string; agentId?: string; cameraId?: string }) {
  results.value = null;
  searchText.value = '';
  await selection.restore({
    customer: selection.customerId ?? undefined,
    premises: target.premisesId,
    agent: target.agentId,
    camera: target.cameraId,
  });
}
</script>

<template>
  <aside class="rail">
    <div class="rail__search">
      <label for="rail-search">Search everything</label>
      <IconField>
        <InputIcon :class="searching ? 'pi pi-spin pi-spinner' : 'pi pi-search'" />
        <InputText
          id="rail-search"
          v-model="searchText"
          placeholder="Name, or press Enter"
          fluid
          @keyup.enter="runSearch"
        />
      </IconField>
      <p class="rail__hint">
        Matches anywhere within a site. Across sites it matches from the start of a name.
      </p>

      <div v-if="results" class="results">
        <template v-if="results.premises.length">
          <p class="results__head">Premises</p>
          <button
            v-for="p in results.premises" :key="p.premisesId"
            class="results__item" type="button"
            @click="jumpTo({ premisesId: p.premisesId })"
          >{{ p.displayName }}</button>
        </template>
        <template v-if="results.cameras.length">
          <p class="results__head">Cameras</p>
          <button
            v-for="c in results.cameras" :key="c.identity"
            class="results__item" type="button"
            @click="jumpTo({ premisesId: c.premisesId, cameraId: c.cameraId })"
          >
            {{ c.displayName }}<span class="results__where">{{ c.premisesId }}</span>
          </button>
        </template>
        <p v-if="!results.premises.length && !results.cameras.length" class="rail__hint">
          Nothing matched in the {{ results.searchedSites }} site(s) searched.
        </p>
      </div>
    </div>

    <CascadeLevel
      v-if="!selection.customerIsPinned"
      v-model="selection.customerId"
      label="Customer"
      :options="customerOptions"
      :automatic="selection.automatic.customer"
      :loading="selection.loading.customer"
    />

    <CascadeLevel
      v-model="selection.premisesId"
      label="Premises"
      :options="premisesOptions"
      :automatic="selection.automatic.premises"
      :loading="selection.loading.premises"
      :blocked-by="selection.customerId ? null : 'customer'"
    />

    <CascadeLevel
      v-model="selection.agentId"
      label="Agent"
      :options="agentOptions"
      :automatic="selection.automatic.agent"
      :loading="selection.loading.agent"
      :blocked-by="selection.premisesId ? null : 'premises'"
    />

    <CascadeLevel
      v-model="selection.cameraId"
      label="Camera"
      :options="cameraOptions"
      :loading="selection.loading.camera"
      :blocked-by="selection.premisesId ? null : 'premises'"
    />

    <Message v-if="selection.error" severity="error" size="small" variant="simple">
      {{ selection.error }}
    </Message>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  padding: 1rem;
  border-right: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
  min-height: 100%;
}

.rail__search {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.rail__search label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.rail__hint {
  margin: 0;
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--p-text-muted-color);
}

.results {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  margin-top: 0.4rem;
  max-height: 16rem;
  overflow-y: auto;
}

.results__head {
  margin: 0.4rem 0 0.1rem;
  font-size: 0.66rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.results__item {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.3rem 0.45rem;
  border: none;
  border-radius: 4px;
  background: none;
  font: inherit;
  font-size: 0.82rem;
  color: var(--p-text-color);
  text-align: left;
  cursor: pointer;
}

.results__item:hover,
.results__item:focus-visible {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}

.results__where {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
</style>
