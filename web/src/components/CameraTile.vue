<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import Button from 'primevue/button';
import { attach, type Attachment } from '@/player/attach';
import { tileView } from '@/player/tile-state';
import type { Camera, Stream } from '@/api';

/**
 * One camera in the grid.
 *
 * The tile owns its player, and the important behaviour is what it does when
 * there is nothing to show: a black rectangle is the same picture whether the
 * agent is unplugged, the stream is thirty seconds from starting, or the site
 * has run out of CPU to convert it. It says which.
 */
const props = defineProps<{
  /** The registered camera, which always exists. */
  camera: Camera;
  /**
   * Its manifest, which exists only once an agent has reported the camera.
   * Absent is an ordinary state, not an error, and the tile says so.
   */
  stream?: Stream;
  viewerCodecs: string[];
  demanded: boolean;
  declined: boolean;
  maxConcurrentTranscodes?: number;
  transcodeRequested: boolean;
  agentStreams?: number;
  /** Full size, which is the one camera allowed a main-resolution stream. */
  expanded?: boolean;
}>();

const emit = defineEmits<{
  transcode: [key: string];
  stopTranscode: [key: string];
  expand: [stream: Stream | null];
}>();

const name = computed(() => props.camera.displayName || props.camera.cameraId);

const video = ref<HTMLVideoElement | null>(null);
const playing = ref(false);
const fatal = ref<string | null>(null);
let player: Attachment | undefined;

const key = computed(() => `${props.camera.assignedTo}/${props.camera.cameraId}`);

const view = computed(() => tileView({
  reported: props.stream !== undefined,
  agentOnline: props.stream?.online ?? false,
  sourceCodec: props.stream?.sourceCodec ?? 'h264',
  sourceCodecProfile: props.stream?.sourceCodecProfile ?? null,
  viewerCodecs: props.viewerCodecs,
  transcodeRequested: props.transcodeRequested,
  demanded: props.demanded,
  declined: props.declined,
  maxConcurrentTranscodes: props.maxConcurrentTranscodes,
  playing: playing.value,
  agentStreams: props.agentStreams,
}));

/**
 * Which rendition to fetch.
 *
 * Expanded means main resolution; a converted camera means the h264 variant.
 * The two combine, and the URL has to match what the control plane was asked
 * to publish or the player waits for a manifest nobody is writing.
 */
const url = computed(() => {
  const m = props.stream?.manifestUrl;
  if (!m) return null;
  if (props.expanded) return props.transcodeRequested ? m.mainH264 : m.main;
  return props.transcodeRequested ? m.subH264 : m.sub;
});

/** Nothing is fetched until the stream is one this viewer could actually play. */
const shouldPlay = computed(() =>
  url.value !== null && (props.stream?.online ?? false) && !props.declined
  && (view.value.status === 'starting' || view.value.status === 'live'));

function start() {
  stop();
  const element = video.value;
  const source = url.value;
  if (!element || !source || !shouldPlay.value) return;
  fatal.value = null;
  player = attach(element, source, {
    onPlaying: () => { playing.value = true; },
    onFatal: (message) => { fatal.value = message; playing.value = false; },
  });
}

function stop() {
  player?.destroy();
  player = undefined;
  playing.value = false;
}

watch([url, shouldPlay], start, { immediate: false });
watch(video, start);
onBeforeUnmount(stop);
</script>

<template>
  <figure class="tile" :class="[`tile--${view.status}`, { 'tile--expanded': expanded }]">
    <div class="tile__frame">
      <video
        ref="video"
        class="tile__video"
        :class="{ 'tile__video--hidden': !playing }"
        muted
        playsinline
        autoplay
      />

      <div v-if="!playing" class="tile__state">
        <i v-if="view.status === 'starting'" class="pi pi-spin pi-spinner" aria-hidden="true" />
        <i v-else class="pi pi-video-slash" aria-hidden="true" />
        <p class="tile__message">{{ fatal ?? view.message }}</p>
        <Button
          v-if="view.offerTranscode"
          size="small"
          severity="secondary"
          label="Convert at the site"
          @click="emit('transcode', key)"
        />
      </div>
    </div>

    <figcaption class="tile__bar">
      <span class="tile__name" :title="name">{{ name }}</span>
      <span class="tile__meta">
        <span v-if="transcodeRequested" class="tile__badge" title="Converted at the site">converted</span>
        <span v-if="stream?.resolution" class="tile__dim">{{ stream.resolution }}</span>
        <Button
          v-if="transcodeRequested"
          size="small" text severity="secondary" icon="pi pi-times"
          aria-label="Stop converting"
          @click="emit('stopTranscode', key)"
        />
        <Button
          size="small" text severity="secondary"
          :icon="expanded ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          :aria-label="expanded ? 'Back to the grid' : 'Open full size'"
          :disabled="!stream"
          @click="emit('expand', expanded || !stream ? null : stream)"
        />
      </span>
    </figcaption>
  </figure>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  margin: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--p-content-background);
}

.tile__frame {
  position: relative;
  /* Cameras are 16:9 often enough that a fixed ratio keeps the grid even, and
     letterboxing an odd one is better than a grid that jumps as tiles load. */
  aspect-ratio: 16 / 9;
  background: #0b0b0d;
}

.tile__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.tile__video--hidden {
  visibility: hidden;
}

.tile__state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.9rem;
  text-align: center;
  color: #c9ccd4;
}

.tile__state .pi {
  font-size: 1.3rem;
  opacity: 0.65;
}

.tile__message {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.4;
  max-width: 26rem;
}

.tile__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.3rem 0.35rem 0.3rem 0.6rem;
  border-top: 1px solid var(--p-content-border-color);
  font-size: 0.78rem;
}

.tile__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile__meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex: none;
}

.tile__dim,
.tile__badge {
  font-size: 0.68rem;
  color: var(--p-text-muted-color);
}

.tile__badge {
  padding: 0.05rem 0.3rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
}

/* An offline camera is dimmed rather than hidden: an operator needs to see
   that it exists and is not reporting, not to have it quietly vanish. */
.tile--offline {
  opacity: 0.72;
}

.tile--expanded .tile__frame {
  aspect-ratio: auto;
  height: min(72vh, 100%);
}
</style>
