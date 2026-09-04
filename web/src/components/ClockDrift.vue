<script setup lang="ts">
import { computed } from 'vue';
import Tag from 'primevue/tag';

/**
 * How far an agent's clock is from the control plane's.
 *
 * Worth its own component because the number is only interesting at three
 * thresholds, and the middle one is the one that matters. Under a minute is
 * ordinary and says nothing. Past roughly five minutes AWS refuses to sign the
 * agent's requests at all, so its configuration fetch fails and it runs with
 * no credentials and no cameras while appearing perfectly healthy — connected,
 * heartbeating, discovering devices it cannot authenticate against.
 *
 * That failure cost a day of searching before it was understood, and every
 * symptom pointed at the camera and its password rather than at a clock. The
 * band between those two is the window in which somebody can still act, which
 * is the only reason to show a number at all.
 *
 * A machine with no clock battery is the usual cause: it boots at whatever was
 * last written to disk and cannot fetch the time until its clock is already
 * close enough to complete a TLS handshake.
 */
const props = defineProps<{ seconds?: number | null }>();

/** The refusal threshold, in seconds. AWS allows roughly five minutes. */
const REFUSED_BEYOND = 300;
const NOTABLE_BEYOND = 60;

const state = computed(() => {
  const skew = props.seconds;
  // Never reported. Deliberately not shown as zero: "unknown" and "correct"
  // are different answers and only one of them is reassuring.
  if (skew == null) return { severity: 'secondary' as const, label: 'unknown', hint:
    'This agent has not reported its clock. Either it has never checked in, or it '
    + 'is running a build from before clock drift was measured.' };

  const size = Math.abs(skew);
  const direction = skew > 0 ? 'behind' : 'ahead';
  const words = size < 90 ? `${Math.round(size)}s` : `${Math.round(size / 60)} min`;

  if (size <= NOTABLE_BEYOND) {
    return { severity: 'success' as const, label: 'in step', hint:
      `This agent's clock is within ${Math.round(size)} seconds of ours.` };
  }
  if (size <= REFUSED_BEYOND) {
    return { severity: 'warn' as const, label: `${words} ${direction}`, hint:
      `Drifting. Past about five minutes AWS refuses to sign this agent's requests, `
      + 'and it will run with no credentials and no cameras while still looking healthy. '
      + 'Check NTP on that machine — a board with no clock battery cannot fix this itself.' };
  }
  return { severity: 'danger' as const, label: `${words} ${direction}`, hint:
    'Far enough out that signed requests are refused. This agent cannot fetch its '
    + 'configuration and will not publish anything until the clock is corrected, however '
    + 'healthy it otherwise appears. Fix NTP on that machine.' };
});
</script>

<template>
  <Tag v-tooltip.left="state.hint" :value="state.label" :severity="state.severity" />
</template>
