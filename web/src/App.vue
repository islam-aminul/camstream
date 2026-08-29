<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import Message from 'primevue/message';
import ProgressSpinner from 'primevue/progressspinner';
import SelectionRail from './components/SelectionRail.vue';
import BrandMark from './components/BrandMark.vue';
import LoginView from './views/LoginView.vue';
import { useSessionStore } from './stores/session';
import { useSelectionStore } from './stores/selection';

const session = useSessionStore();
const selection = useSelectionStore();
const route = useRoute();

/**
 * The pages, each with the sentence that explains it on hover.
 *
 * "Add cameras" was the wrong name for what that page does. Adding is the last
 * of four steps - enrol an agent, give it credentials, scan the network,
 * approve what comes back - and somebody who has not done it before reads
 * "Add cameras" and looks for a form with a camera's address in it.
 */
const pages = [
  { name: 'live', label: 'Live', icon: 'pi-video',
    hint: 'Watch cameras at the selected site' },
  { name: 'cameras', label: 'Cameras', icon: 'pi-camera',
    hint: 'Every camera in service: rename, check and watch' },
  { name: 'add', label: 'Set up', icon: 'pi-compass',
    hint: 'Enrol an agent, scan its network, and approve the cameras it finds' },
  { name: 'agents', label: 'Agents', icon: 'pi-server',
    hint: 'The machines that publish streams, and what each can carry' },
  { name: 'premises', label: 'Premises', icon: 'pi-building',
    hint: 'Sites, and the agents that belong to them' },
  { name: 'users', label: 'Users', icon: 'pi-users',
    hint: 'Who may sign in, and what they may see' },
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
      <span class="brand">
        <BrandMark label="CamStream" />
        CamStream
      </span>
      <nav>
        <RouterLink
          v-for="page in pages" :key="page.name"
          v-tooltip.bottom="page.hint"
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
        <button
          v-tooltip.bottom="'End this session on this browser'"
          type="button" class="topbar__out" @click="session.end(null)"
        >Sign out</button>
      </div>
    </header>

    <!-- Dismissable. This is usually "your previous session was signed out",
         which is information about something that has already happened; left
         undismissable it sat across the top of the console for the rest of the
         visit with no way to acknowledge it. -->
    <Message
      v-if="session.notice" severity="warn" class="notice" closable
      @close="session.clearNotice()"
    >
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
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--p-primary-color);
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
