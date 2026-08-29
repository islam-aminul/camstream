import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { api, type Agent, type Camera, type Customer, type Premises } from '@/api';
import { useSessionStore } from './session';
import { settleLevel, createLatest } from './cascade';

/**
 * The selection rail's state: customer, then premises, then agent, then camera.
 *
 * The rules, all of which have a reason:
 *
 *  - A level holding exactly one option selects it, and says that it did. A
 *    silent selection is indistinguishable from a choice the user made and
 *    forgot, so the control marks itself.
 *  - A level holding several waits. Guessing spends the customer's money at a
 *    site nobody asked about.
 *  - A level holding none says so and disables everything below it. An empty
 *    dropdown and a loading dropdown otherwise look identical.
 *  - Changing a level clears everything beneath it before re-applying
 *    auto-selection, or a stale camera survives under a new site.
 *  - A level that later gains options keeps its current value but stops
 *    calling it automatic — an agent enrolling must not silently move what
 *    somebody is watching.
 *  - Customer is fixed and hidden when the caller's token pins it, which is
 *    everyone but the platform operator. That is the same rule as
 *    auto-select-when-single, taken one step further: an administrator with
 *    one possible answer should not be shown the question.
 *
 * Two things here are about ordering rather than rules, and both were real
 * failures before they were guarded: an answer to a superseded request must
 * never write (see `createLatest`), and restoring a link must not wake the
 * watchers whose work it is already doing.
 */
export const useSelectionStore = defineStore('selection', () => {
  const session = useSessionStore();
  const latest = createLatest();

  const customers = ref<Customer[]>([]);
  const premises = ref<Premises[]>([]);
  const agents = ref<Agent[]>([]);
  const cameras = ref<Camera[]>([]);

  const customerId = ref<string | null>(null);
  const premisesId = ref<string | null>(null);
  const agentId = ref<string | null>(null);
  const cameraId = ref<string | null>(null);

  /** Levels the app chose rather than the user, so the UI can say so. */
  const automatic = ref<Record<string, boolean>>({});
  const loading = ref<Record<string, boolean>>({});
  const error = ref<string | null>(null);

  /**
   * True while `restore` is driving the levels itself. The watchers below
   * exist to cascade a user's change; during a restore they would re-issue
   * every query restore is already making, and the duplicates race.
   */
  let restoring = false;

  /**
   * Only the platform operator picks a customer; everyone else's token names
   * one, so the level is answered before it is asked.
   */
  const customerIsPinned = computed(() => session.me?.role !== 'superadmin');

  /** What a superadmin must pass on every call; undefined for everyone else. */
  const tenantParam = computed(() =>
    customerIsPinned.value ? undefined : (customerId.value ?? undefined));

  /**
   * Runs a level's query and applies it only if it is still the current one.
   *
   * The ticket is taken before the request goes out and checked after it comes
   * back; everything in between — the write, the error, the spinner — belongs
   * to whichever request holds the level now.
   */
  async function load<T>(level: string, work: () => Promise<T>, apply: (value: T) => void) {
    const ticket = latest.begin(level);
    loading.value = { ...loading.value, [level]: true };
    try {
      const value = await work();
      if (!latest.current(level, ticket)) return;
      apply(value);
    } catch (err) {
      if (latest.current(level, ticket)) error.value = (err as Error).message;
    } finally {
      // A superseded request must not clear a spinner it no longer owns.
      if (latest.current(level, ticket)) {
        loading.value = { ...loading.value, [level]: false };
      }
    }
  }

  /** Applies the shared cascade rules, and records whether this level chose. */
  function settle(level: string, current: string | null, options: string[]): string | null {
    const settled = settleLevel(current, options);
    automatic.value = { ...automatic.value, [level]: settled.automatic };
    return settled.value;
  }

  async function loadCustomers() {
    if (customerIsPinned.value) {
      customerId.value = session.me?.tenantId ?? null;
      return;
    }
    await load('customer', () => api.customers(), (list) => {
      customers.value = list;
      customerId.value = settle('customer', customerId.value, list.map((c) => c.tenantId));
    });
  }

  async function loadPremises() {
    if (!customerId.value) { premises.value = []; premisesId.value = null; return; }
    await load('premises', () => api.premises(tenantParam.value), (list) => {
      premises.value = list;
      premisesId.value = settle('premises', premisesId.value, list.map((p) => p.premisesId));
    });
  }

  async function loadAgents() {
    if (!premisesId.value) { agents.value = []; agentId.value = null; return; }
    await load('agent', () => api.agents({
      tenantId: tenantParam.value, premisesId: premisesId.value!, limit: 200,
    }), (page) => {
      agents.value = page.items;
      agentId.value = settle('agent', agentId.value, page.items.map((a) => a.thingName));
    });
  }

  async function loadCameras() {
    if (!premisesId.value) { cameras.value = []; cameraId.value = null; return; }
    await load('camera', () => api.cameras({
      tenantId: tenantParam.value,
      premisesId: premisesId.value!,
      agentId: agentId.value ?? undefined,
      limit: 200,
    }), (page) => {
      cameras.value = page.items;
      // Deliberately never auto-selected. A camera is what the user came to
      // choose, and picking one for them starts a stream they did not ask for.
      if (cameraId.value && !page.items.some((c) => c.cameraId === cameraId.value)) {
        cameraId.value = null;
      }
    });
  }

  /**
   * Cameras are worth loading only once the agent level has settled.
   *
   * Loading them alongside the agents means fetching every camera at the site
   * and then, a moment later, fetching the one agent's cameras instead —
   * paying for a page of rows nobody will ever see.
   */
  async function loadAgentsThenCameras() {
    await loadAgents();
    // If an agent settled, its own watcher has already asked for its cameras.
    if (agentId.value === null) await loadCameras();
  }

  // Each level clears what depends on it, then reloads. These run on `sync`
  // flush so a cascade completes within the assignment that caused it: a
  // half-applied selection must never be observable, and `restoring` has to
  // still be true when the watcher would otherwise fire.
  watch(customerId, () => {
    if (restoring) return;
    premisesId.value = null; agentId.value = null; cameraId.value = null;
    agents.value = []; cameras.value = [];
    void loadPremises();
  }, { flush: 'sync' });

  watch(premisesId, () => {
    if (restoring) return;
    agentId.value = null; cameraId.value = null;
    void loadAgentsThenCameras();
  }, { flush: 'sync' });

  watch(agentId, () => {
    if (restoring) return;
    cameraId.value = null;
    void loadCameras();
  }, { flush: 'sync' });

  /**
   * Restores a selection from a link, top down, so each level settles in turn.
   *
   * The watchers are held off for the duration: restore is doing their job
   * already, and letting both run issued every query twice and let the loser
   * of the race write last.
   *
   * Each value from the link is applied only if it is really there, so a link
   * to a camera that has since been removed degrades to its premises rather
   * than to an empty page.
   */
  async function restore(from: { customer?: string; premises?: string; agent?: string; camera?: string }) {
    restoring = true;
    try {
      await loadCustomers();
      if (from.customer && !customerIsPinned.value) customerId.value = from.customer;

      await loadPremises();
      if (from.premises && premises.value.some((p) => p.premisesId === from.premises)) {
        premisesId.value = from.premises;
      }

      await loadAgents();
      if (from.agent && agents.value.some((a) => a.thingName === from.agent)) {
        agentId.value = from.agent;
      }

      await loadCameras();
      if (from.camera && cameras.value.some((c) => c.cameraId === from.camera)) {
        cameraId.value = from.camera;
      }
    } finally {
      restoring = false;
    }
  }

  const ready = computed(() => Boolean(customerId.value && premisesId.value));

  return {
    customers, premises, agents, cameras,
    customerId, premisesId, agentId, cameraId,
    automatic, loading, error,
    customerIsPinned, tenantParam, ready,
    loadCustomers, loadPremises, loadAgents, loadCameras, restore,
  };
});
