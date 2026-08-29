<script setup lang="ts">
import { useSelectionStore } from '@/stores/selection';
const selection = useSelectionStore();
</script>

<template>
  <div>
    <div class="page-head"><h1>Live</h1></div>
    <p v-if="!selection.ready" class="empty">Choose a premises on the left to begin.</p>
    <p v-else class="empty">Live for {{ selection.premisesId }} — built in a later phase.</p>
  </div>
</template>
