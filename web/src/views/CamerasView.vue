<script setup lang="ts">
import { computed } from 'vue';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import PagedTable from '@/components/PagedTable.vue';
import { useSelectionStore } from '@/stores/selection';
import { api, type Camera } from '@/api';
import { useRouter } from 'vue-router';

/**
 * Every camera at the selected site, filtered by the rail.
 *
 * The rail already narrows to a customer, a site and optionally an agent, so
 * this page adds only what the rail cannot express: a search within the
 * narrowing, and the state of each camera.
 */
const selection = useSelectionStore();
const router = useRouter();

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

/** Watching one camera is the rail's camera level plus the live view. */
function watchIt(camera: Camera) {
  selection.cameraId = camera.cameraId;
  void router.push({ name: 'live', query: router.currentRoute.value.query });
}
</script>

<template>
  <div>
    <div class="page-head"><h1>Cameras</h1></div>

    <p v-if="!selection.ready" class="empty">Choose a premises on the left to begin.</p>

    <PagedTable
      v-else
      :load="load"
      :reset-on="resetOn"
      row-key="identity"
      search-label="camera names"
    >
      <Column field="displayName" header="Name" />
      <Column field="cameraId" header="Id" />
      <Column header="Agent">
        <template #body="{ data }">
          <span class="mono">{{ data.assignedTo }}</span>
        </template>
      </Column>
      <Column field="sourceCodec" header="Codec">
        <template #body="{ data }">{{ data.sourceCodec ?? '—' }}</template>
      </Column>
      <Column header="State">
        <template #body="{ data }">
          <Tag
            :value="data.publishing ? 'publishing' : 'idle'"
            :severity="data.publishing ? 'success' : 'secondary'"
          />
        </template>
      </Column>
      <Column header="" style="width: 6rem">
        <template #body="{ data }">
          <Button size="small" text label="Watch" @click="watchIt(data)" />
        </template>
      </Column>
    </PagedTable>
  </div>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.76rem;
  color: var(--p-text-muted-color);
}
</style>
