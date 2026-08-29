import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { api, type Agent, type Camera, type Customer, type Premises } from '@/api';
import { useSessionStore } from './session';
import { settleLevel } from './cascade';

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
 */
export const useSelectionStore = defineStore('selection', () => {
  const session = useSessionStore();

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
   * Only the platform operator picks a customer; everyone else's token names
   * one, so the level is answered before it is asked.
   */
  const customerIsPinned = computed(() => session.me?.role !== 'superadmin');

  /** What a superadmin must pass on every call; undefined for everyone else. */
  const tenantParam = computed(() =>
    customerIsPinned.value ? undefined : (customerId.value ?? undefined));

  function busy<T>(level: string, work: () => Promise<T>): Promise<T | undefined> {
    loading.value = { ...loading.value, [level]: true };
    return work()
      .catch((err: Error) => { error.value = err.message; return undefined; })
      .finally(() => { loading.value = { ...loading.value, [level]: false }; });
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
    const list = await busy('customer', () => api.customers());
    customers.value = list ?? [];
    customerId.value = settle('customer', customerId.value, customers.value.map((c) => c.tenantId));
  }

  async function loadPremises() {
    if (!customerId.value) { premises.value = []; premisesId.value = null; return; }
    const list = await busy('premises', () => api.premises(tenantParam.value));
    premises.value = list ?? [];
    premisesId.value = settle('premises', premisesId.value, premises.value.map((p) => p.premisesId));
  }

  async function loadAgents() {
    if (!premisesId.value) { agents.value = []; agentId.value = null; return; }
    const page = await busy('agent', () => api.agents({
      tenantId: tenantParam.value, premisesId: premisesId.value!, limit: 200,
    }));
    agents.value = page?.items ?? [];
    agentId.value = settle('agent', agentId.value, agents.value.map((a) => a.thingName));
  }

  async function loadCameras() {
    if (!premisesId.value) { cameras.value = []; cameraId.value = null; return; }
    const page = await busy('camera', () => api.cameras({
      tenantId: tenantParam.value,
      premisesId: premisesId.value!,
      agentId: agentId.value ?? undefined,
      limit: 200,
    }));
    cameras.value = page?.items ?? [];
    // Deliberately never auto-selected. A camera is what the user came to
    // choose, and picking one for them starts a stream they did not ask for.
    if (cameraId.value && !cameras.value.some((c) => c.cameraId === cameraId.value)) {
      cameraId.value = null;
    }
  }

  // Each level clears what depends on it, then reloads. Doing this with
  // watchers rather than inside the setters means a selection arriving from a
  // URL settles the same way as one arriving from a click.
  watch(customerId, () => {
    premisesId.value = null; agentId.value = null; cameraId.value = null;
    agents.value = []; cameras.value = [];
    void loadPremises();
  });
  watch(premisesId, () => {
    agentId.value = null; cameraId.value = null;
    void loadAgents();
    void loadCameras();
  });
  watch(agentId, () => {
    cameraId.value = null;
    void loadCameras();
  });

  /** Restores a selection from a link, top down, so each level settles in turn. */
  async function restore(from: { customer?: string; premises?: string; agent?: string; camera?: string }) {
    await loadCustomers();
    if (from.customer && !customerIsPinned.value) customerId.value = from.customer;
    await loadPremises();
    if (from.premises) premisesId.value = from.premises;
    await loadAgents();
    if (from.agent) agentId.value = from.agent;
    await loadCameras();
    if (from.camera) cameraId.value = from.camera;
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
