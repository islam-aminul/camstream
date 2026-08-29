<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import SelectionRail from './components/SelectionRail.vue';
import LoginView from './views/LoginView.vue';
import { useSessionStore } from './stores/session';
import { useSelectionStore } from './stores/selection';

const session = useSessionStore();
const selection = useSelectionStore();
const route = useRoute();

const pages = [
  { name: 'live', label: 'Live', icon: 'pi-video' },
  { name: 'cameras', label: 'Cameras', icon: 'pi-camera' },
  { name: 'add', label: 'Add cameras', icon: 'pi-plus-circle' },
  { name: 'agents', label: 'Agents', icon: 'pi-server' },
  { name: 'premises', label: 'Premises', icon: 'pi-building' },
  { name: 'users', label: 'Users', icon: 'pi-users' },
];

async function begin() {
  if (!(await session.start())) return;
  // Restore top down, so each level settles in turn and a shared link lands
  // in the same state the person who sent it was looking at.
  await selection.restore({
    customer: route.query.customer as string | undefined,
    premises: route.query.premises as string | undefined,
    agent: route.query.agent as string | undefined,
    camera: route.query.camera as string | undefined,
  });
}

onMounted(begin);
watch(() => session.me, (me) => { if (me) void selection.loadCustomers(); });
</script>

<template>
  <div v-if="!session.ready" class="centre"><ProgressSpinner /></div>

  <LoginView v-else-if="!session.me" :notice="session.notice" @signed-in="begin" />

  <div v-else class="shell">
    <header class="topbar">
      <span class="brand">CamStream</span>
      <nav>
        <RouterLink
          v-for="page in pages" :key="page.name"
          :to="{ name: page.name, query: $route.query }"
          class="topbar__link"
        >
          <i :class="['pi', page.icon]" aria-hidden="true" />
          {{ page.label }}
        </RouterLink>
      </nav>
      <div class="topbar__who">
        <span>{{ session.me.email }}</span>
        <span class="topbar__role">{{ session.me.role }}</span>
        <button type="button" class="topbar__out" @click="session.end(null)">Sign out</button>
      </div>
    </header>

    <Message v-if="session.notice" severity="warn" class="notice" :closable="false">
      {{ session.notice }}
    </Message>

    <div class="body">
      <SelectionRail />
      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.centre {
  display: grid;
  place-items: center;
  min-height: 100vh;
}

.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
}

.brand {
  font-weight: 700;
  letter-spacing: -0.01em;
}

.topbar nav {
  display: flex;
  gap: 0.25rem;
  flex: 1;
}

.topbar__link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.7rem;
  border-radius: 6px;
  font-size: 0.88rem;
  color: var(--p-text-muted-color);
  text-decoration: none;
}

.topbar__link:hover {
  background: var(--p-content-hover-background);
  color: var(--p-text-color);
}

.topbar__link.router-link-active {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}

.topbar__who {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.topbar__role {
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.topbar__out {
  border: none;
  background: none;
  font: inherit;
  color: var(--p-primary-color);
  cursor: pointer;
}

.notice {
  margin: 0;
  border-radius: 0;
}

/* The rail is fixed-width and the content takes what is left, which is what
   lets the grid decide its own column count from the space it actually has. */
.body {
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.content {
  padding: 1.25rem;
  min-width: 0;
  overflow: auto;
}

@media (max-width: 60rem) {
  .body { grid-template-columns: 1fr; }
}
</style>
