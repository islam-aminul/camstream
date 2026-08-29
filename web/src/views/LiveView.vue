<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from 'vue';
import SelectButton from 'primevue/selectbutton';
import Button from 'primevue/button';
import Message from 'primevue/message';
import ProgressBar from 'primevue/progressbar';
import CameraTile from '@/components/CameraTile.vue';
import { useSelectionStore } from '@/stores/selection';
import { useLiveStore } from '@/stores/live';
import { TILE_CHOICES, costNote, gridTemplate } from '@/stores/grid';
import type { Stream } from '@/api';

/**
 * The wall.
 *
 * Three things shape this page. The grid fills the width it is given rather
 * than the width it wishes for, so the tile count is a ceiling on the page and
 * the browser decides the columns. Paging is forward and back rather than
 * numbered, because the store underneath pages by cursor and pretending
 * otherwise would mean scanning a site of ten thousand cameras to reach page
 * seven. And the tile count carries a price, because it is the only control on
 * this page that spends money.
 */
const selection = useSelectionStore();
const live = useLiveStore();

const expanded = computed(() => live.main);

/**
 * What the wall shows.
 *
 * Expanding a camera shows that camera and nothing else. It used to leave the
 * tile in its grid cell and merely change the frame's height, so "Open full
 * size" produced a tile the same size as before - while quietly fetching the
 * main-resolution stream, paying for it, and displaying it in a ninth of the
 * page.
 *
 * The other cameras keep their demand while one is expanded. They are still
 * the wall you were watching and you are one click from them; stopping and
 * restarting an agent's ffmpeg for a few seconds of zoom costs more than it
 * saves.
 */
const shown = computed(() => {
  const one = live.main;
  if (!one) return live.entries;
  const found = live.entries.filter((entry) =>
    entry.camera.cameraId === one.cameraId && entry.camera.assignedTo === one.thingName);
  return found.length ? found : live.entries;
});

const style = computed(() => ({
  gridTemplateColumns: expanded.value ? '1fr' : gridTemplate(live.tiles),
}));

const cost = computed(() => costNote(live.streams.length));

/** The camera the rail has selected, if it is on this page, so it can be lit. */
const highlighted = computed(() => selection.cameraId);

function expand(stream: Stream | null) {
  live.openMain(stream ? { thingName: stream.thingName, cameraId: stream.cameraId } : null);
}

onMounted(() => { if (selection.ready) void live.first(); });
onBeforeUnmount(() => { void live.release(); });
</script>

<template>
  <div class="live">
    <div class="page-head">
      <h1>Live</h1>

      <div v-if="selection.ready" class="controls">
        <div v-if="!live.pinnedToOne && !expanded" class="tiles">
          <label for="tiles">Tiles</label>
          <SelectButton
            v-tooltip.bottom="'How many cameras this page may show at once. Each one is a stream somebody is paying for.'"
            :model-value="live.tiles"
            :options="[...TILE_CHOICES]"
            :allow-empty="false"
            aria-labelledby="tiles"
            @update:model-value="live.setTiles($event)"
          />
        </div>

        <div v-if="!live.pinnedToOne && !expanded" class="paging">
          <span class="paging__count">
            <template v-if="live.total">{{ live.from }}–{{ live.to }} of {{ live.total }}</template>
            <template v-else>No cameras</template>
          </span>
          <Button
            v-tooltip.bottom="'First page'"
            icon="pi pi-angle-double-left" text severity="secondary" aria-label="First page"
            :disabled="!live.hasPrevious" @click="live.first()"
          />
          <Button
            v-tooltip.bottom="'Previous page'"
            icon="pi pi-angle-left" text severity="secondary" aria-label="Previous page"
            :disabled="!live.hasPrevious" @click="live.previous()"
          />
          <Button
            v-tooltip.bottom="'Next page'"
            icon="pi pi-angle-right" text severity="secondary" aria-label="Next page"
            :disabled="!live.hasNext" @click="live.next()"
          />
        </div>
      </div>
    </div>

    <p v-if="!selection.ready" class="empty">Choose a premises on the left to begin.</p>

    <template v-else>
      <!-- The one control on this page that spends money says what it spends. -->
      <p class="cost">
        {{ cost }}
        <template v-if="live.pinnedToOne">
          Showing one camera — clear Camera on the left for the whole wall.
        </template>
      </p>

      <Message v-if="live.error" severity="error" size="small" variant="simple">
        {{ live.error }}
      </Message>

      <ProgressBar v-if="live.loading" mode="indeterminate" class="thin" />

      <p v-else-if="!live.entries.length" class="empty">
        Nothing to show here. {{ selection.agentId ? 'This agent has no cameras.' : 'This site has no cameras yet.' }}
      </p>

      <template v-else>
        <p v-if="expanded" class="back">
          <Button
            v-tooltip.right="'Show every camera on this page again'"
            size="small" text icon="pi pi-arrow-left" label="Back to the wall"
            @click="expand(null)"
          />
        </p>

        <div class="grid" :style="style">
          <CameraTile
            v-for="entry in shown"
            :key="entry.key"
            :class="{ 'tile--selected': highlighted === entry.camera.cameraId }"
            :camera="entry.camera"
            :stream="entry.stream"
            :viewer-codecs="live.codecs"
            :demanded="live.demandedFor.has(entry.key)"
            :declined="live.declinedFor.has(entry.key)"
            :max-concurrent-transcodes="live.declinedFor.get(entry.key)"
            :transcode-requested="live.transcode.has(entry.key)"
            :agent-streams="live.streamsPerAgent.get(entry.camera.assignedTo)"
            :expanded="expanded?.cameraId === entry.camera.cameraId
              && expanded?.thingName === entry.camera.assignedTo"
            @transcode="live.requestTranscode($event)"
            @stop-transcode="live.stopTranscode($event)"
            @expand="expand"
          />
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.controls {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}

.tiles,
.paging {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.tiles label,
.paging__count {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.cost {
  margin: 0;
  font-size: 0.76rem;
  color: var(--p-text-muted-color);
}

.grid {
  display: grid;
  /* Columns come from the store, which derives them from the tile count. */
  gap: 0.6rem;
  align-items: start;
}

.thin {
  height: 3px;
}

.back {
  margin: 0;
}

/* The camera chosen in the rail, so a search that lands here is visibly the
   thing that was searched for. */
.tile--selected {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}
</style>
