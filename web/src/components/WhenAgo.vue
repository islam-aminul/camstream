<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

/**
 * A moment in time, shown the way people actually read one.
 *
 * Relative on the face of it — "3 minutes ago" is what you scan a table for —
 * and the exact instant on hover, because that is what you need the moment you
 * are correlating with a log or a customer's account of when something
 * happened. Showing only one of the two makes the other a calculation.
 *
 * The absolute form always carries its timezone. An estate spans them, and a
 * bare local time from an unstated zone is not a time; the whole reason this
 * component exists is a Raspberry Pi whose clock was a month out, which is
 * exactly the situation where an ambiguous timestamp misleads worst.
 *
 * Ticks itself, so a page left open does not quietly become wrong.
 */
const props = withDefaults(defineProps<{
  /** Epoch seconds. Null or undefined renders the `absent` text. */
  at?: number | null;
  /** What to say when there is no timestamp at all. */
  absent?: string;
}>(), { at: null, absent: 'never' });

const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now(); }, 15_000);
onBeforeUnmount(() => clearInterval(timer));

const relative = computed(() => {
  if (props.at == null) return props.absent;
  const seconds = Math.round(now.value / 1000 - props.at);

  // Future times are not an error worth hiding: a clock that is ahead is the
  // same class of problem as one behind, and saying "in 3 minutes" is a
  // clearer symptom than silently clamping it to "just now".
  const ahead = seconds < 0;
  const s = Math.abs(seconds);
  const say = (value: number, unit: string) => {
    const rounded = Math.round(value);
    const plural = `${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
    return ahead ? `in ${plural}` : `${plural} ago`;
  };

  if (s < 45) return ahead ? 'in a moment' : 'just now';
  if (s < 5400) return say(s / 60, 'minute');
  if (s < 172800) return say(s / 3600, 'hour');
  return say(s / 86400, 'day');
});

/** The exact instant, with its offset, for hovering and for copying. */
const exact = computed(() => {
  if (props.at == null) return props.absent;
  return new Date(props.at * 1000).toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'long',
  });
});
</script>

<template>
  <time
    v-tooltip.top="exact"
    :datetime="at == null ? undefined : new Date(at * 1000).toISOString()"
    :class="{ 'when--absent': at == null }"
  >{{ relative }}</time>
</template>

<style scoped>
time {
  cursor: help;
  white-space: nowrap;
}

.when--absent {
  color: var(--p-text-muted-color);
  font-style: italic;
  cursor: default;
}
</style>
