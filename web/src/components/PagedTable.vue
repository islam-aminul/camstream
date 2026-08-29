<script setup lang="ts" generic="T">
import { ref, watch, onMounted } from 'vue';
import DataTable from 'primevue/datatable';
import InputText from 'primevue/inputtext';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { Page } from '@/api';

/**
 * A table over a list too large to hold, with a search box.
 *
 * Every admin page in this console shows the same shape: a filtered slice of
 * something there may be ten thousand of, fetched a page at a time. The
 * pieces that are easy to get wrong — not letting a slow page overwrite a
 * fast one, resetting to the first page when the filter changes, debouncing
 * the search so a keystroke is not a query — live here once rather than four
 * times.
 *
 * Paging is forward and back. The cursor is opaque and only the server can
 * mint one, so there is no page seven to jump to, and offering one would mean
 * scanning the six before it.
 */
const props = defineProps<{
  /** Fetches one page. Given the cursor and size of the page being opened. */
  load: (params: { q?: string; cursor?: string; limit: number }) => Promise<Page<T>>;
  /** Rows per page. */
  limit?: number;
  /** What the search box is searching, for its placeholder. */
  searchLabel?: string;
  /** Values that, when they change, invalidate every cursor held. */
  resetOn?: unknown;
  /** The field that identifies a row. */
  rowKey: string;
}>();

const rows = ref<T[]>([]) as import('vue').Ref<T[]>;
const total = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const q = ref('');

/** One cursor per boundary crossed; index n opens page n. */
const cursors = ref<(string | undefined)[]>([undefined]);
const page = ref(0);
const nextCursor = ref<string | undefined>(undefined);

/**
 * Only the newest request may write. A search narrowing from three letters to
 * four puts two queries in flight, and the broader one is the slower one.
 */
let ticket = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function fetchPage() {
  const mine = ++ticket;
  loading.value = true;
  try {
    const result = await props.load({
      q: q.value.trim() || undefined,
      cursor: cursors.value[page.value],
      limit: props.limit ?? 25,
    });
    if (mine !== ticket) return;
    rows.value = result.items;
    total.value = result.total;
    nextCursor.value = result.cursor;
    if (result.cursor) cursors.value[page.value + 1] = result.cursor;
    error.value = null;
  } catch (err) {
    if (mine === ticket) error.value = (err as Error).message;
  } finally {
    if (mine === ticket) loading.value = false;
  }
}

async function first() {
  page.value = 0;
  cursors.value = [undefined];
  await fetchPage();
}

function onSearch() {
  if (debounce) clearTimeout(debounce);
  // Long enough that typing a name is one query rather than eight.
  debounce = setTimeout(() => { void first(); }, 300);
}

// A changed filter invalidates every cursor: they are offsets into a result
// set that no longer exists.
watch(() => props.resetOn, () => { void first(); }, { deep: true });

onMounted(() => { void first(); });

defineExpose({ refresh: first });
</script>

<template>
  <div class="paged">
    <div class="paged__bar">
      <IconField class="paged__search">
        <InputIcon :class="loading ? 'pi pi-spin pi-spinner' : 'pi pi-search'" />
        <InputText
          v-model="q"
          :placeholder="`Search ${searchLabel ?? 'by name'}`"
          fluid
          @input="onSearch"
        />
      </IconField>

      <span class="paged__count">
        <!-- Counted from the requested page size, not from the rows returned:
             a short last page would otherwise renumber every page before it. -->
        <template v-if="total">
          {{ page * (limit ?? 25) + (rows.length ? 1 : 0) }}–{{ page * (limit ?? 25) + rows.length }}
          of {{ total }}
        </template>
        <template v-else-if="!loading">Nothing here</template>
      </span>

      <Button
        icon="pi pi-angle-double-left" text severity="secondary" aria-label="First page"
        :disabled="page === 0" @click="first()"
      />
      <Button
        icon="pi pi-angle-left" text severity="secondary" aria-label="Previous page"
        :disabled="page === 0" @click="page -= 1; fetchPage()"
      />
      <Button
        icon="pi pi-angle-right" text severity="secondary" aria-label="Next page"
        :disabled="!nextCursor" @click="page += 1; fetchPage()"
      />
      <Button
        icon="pi pi-refresh" text severity="secondary" aria-label="Reload"
        @click="fetchPage()"
      />
    </div>

    <Message v-if="error" severity="error" size="small" variant="simple">{{ error }}</Message>

    <DataTable :value="rows" :data-key="rowKey" size="small" striped-rows>
      <slot />
      <template #empty>
        <p class="paged__empty">
          {{ loading ? 'Loading…' : q ? 'Nothing matched that search.' : 'Nothing here yet.' }}
        </p>
      </template>
    </DataTable>
  </div>
</template>

<style scoped>
.paged {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.paged__bar {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.paged__search {
  flex: 1 1 18rem;
  max-width: 24rem;
}

.paged__count {
  margin-left: auto;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.paged__empty {
  margin: 0;
  padding: 0.6rem 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
</style>
