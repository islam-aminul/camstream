<script setup lang="ts">
/**
 * The CamStream mark: a lens, and the signal leaving it.
 *
 * Drawn in `currentColor` and sized in `em`, so it takes the colour and the
 * scale of whatever it sits next to rather than needing a variant per place it
 * appears — the top bar and the sign-in card want the same mark at different
 * sizes and, in dark mode, different colours.
 *
 * Inline rather than an <img>: an external file cannot inherit colour, and at
 * this size it would be a second request for about half a kilobyte.
 */
withDefaults(defineProps<{ label?: string }>(), { label: '' });
</script>

<template>
  <svg
    class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <circle cx="9" cy="12" r="4.3" />
    <circle cx="9" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <path d="M16.4 8.5a5.4 5.4 0 0 1 0 7" />
    <path d="M19.6 5.7a9.4 9.4 0 0 1 0 12.6" />
  </svg>
</template>

<style scoped>
.mark {
  width: 1.15em;
  height: 1.15em;
  flex: none;
  /* Optical centring: the arcs weight the mark to the right of its box. */
  margin-bottom: -0.08em;
}
</style>
