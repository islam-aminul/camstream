<script setup lang="ts">
import { computed } from 'vue';
import Select from 'primevue/select';
import { levelStatus } from '@/stores/cascade';

/**
 * One level of the selection rail.
 *
 * A searchable Select rather than a native one, because at a thousand agents a
 * native dropdown is a scroll bar and a hope. PrimeVue's filter is
 * keyboard-navigable and announces its option count, which is the part that
 * matters when the list is longer than the screen.
 */
const props = defineProps<{
  label: string;
  options: { value: string; label: string; hint?: string }[];
  loading?: boolean;
  /** Why the level cannot be used yet, when it cannot. */
  blockedBy?: string | null;
}>();

const model = defineModel<string | null>();

const empty = computed(() => !props.loading && props.options.length === 0);

/**
 * Three states that look alike and are not: waiting for data, having none, and
 * having some but nothing chosen. Saying which is the whole job of this line.
 */
const status = computed(() => levelStatus({
  blockedBy: props.blockedBy,
  loading: props.loading,
  options: props.options.length,
  selected: Boolean(model.value),
}));
</script>

<template>
  <div class="level">
    <label :for="`level-${label}`">{{ label }}</label>
    <Select
      :id="`level-${label}`"
      v-model="model"
      :options="options"
      option-label="label"
      option-value="value"
      :placeholder="empty ? 'None here' : `Select ${label.toLowerCase()}`"
      :disabled="Boolean(blockedBy) || empty"
      :loading="loading"
      :filter="options.length > 8"
      filter-placeholder="Type to narrow"
      :empty-filter-message="`No ${label.toLowerCase()} matches`"
      show-clear
      fluid
    >
      <template #option="{ option }">
        <div class="option">
          <span class="option__label">{{ option.label }}</span>
          <span v-if="option.hint" class="option__hint">{{ option.hint }}</span>
        </div>
      </template>
    </Select>
    <p class="level__status">{{ status }}</p>
  </div>
</template>

<style scoped>
.level {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.level__status {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.3;
  color: var(--p-text-muted-color);
}

.option {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.option__hint {
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
}
</style>
