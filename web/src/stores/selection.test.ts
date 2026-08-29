import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The two failures that survive a typecheck and a unit test of the rules: a
 * slow answer to a question nobody is asking any more, and a deep link that
 * unpicks itself. Both are about *ordering*, so both need the real store with
 * its real watchers rather than the pure functions underneath it.
 */

/** Resolves after `delay` turns of the microtask queue, deterministically. */
function slow<T>(value: T, delay: number): Promise<T> {
  let p = Promise.resolve();
  for (let i = 0; i < delay; i += 1) p = p.then(() => {});
  return p.then(() => value);
}

const calls: string[] = [];
let cameraDelay: (premisesId: string, agentId: string | undefined) => number = () => 0;
let agentDelay = 1;

vi.mock('@/api', () => ({
  api: {
    customers: () => slow([{ tenantId: 'acme', displayName: 'Acme' }], 0),
    premises: () => slow([
      { premisesId: 'hq', displayName: 'HQ' },
      { premisesId: 'depot', displayName: 'Depot' },
      { premisesId: 'annex', displayName: 'Annex' },
    ], 0),
    // HQ has one agent, so it settles; every other site has two, so the agent
    // level waits and the camera level loads the whole site.
    agents: ({ premisesId }: { premisesId: string }) => slow(
      premisesId === 'hq'
        ? { total: 1, items: [{ thingName: 'acme--hq--edge-01', cameraCount: 2 }] }
        : {
            total: 2,
            items: [
              { thingName: `acme--${premisesId}--edge-07`, cameraCount: 1 },
              { thingName: `acme--${premisesId}--edge-08`, cameraCount: 1 },
            ],
          },
      agentDelay,
    ),
    cameras: ({ premisesId, agentId }: { premisesId: string; agentId?: string }) => {
      calls.push(agentId ?? `all@${premisesId}`);
      const items = agentId
        ? [{ cameraId: 'cam-a', identity: 'x', displayName: 'A', assignedTo: agentId }]
        : [
            { cameraId: `${premisesId}-1`, identity: 'x', displayName: 'A', assignedTo: 'a' },
            { cameraId: `${premisesId}-2`, identity: 'y', displayName: 'Z', assignedTo: 'b' },
          ];
      return slow({ total: items.length, items }, cameraDelay(premisesId, agentId));
    },
  },
}));

const { useSelectionStore } = await import('./selection');
const { useSessionStore } = await import('./session');

/** Lets every pending watcher and promise chain drain. */
async function settled() {
  for (let i = 0; i < 60; i += 1) await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  calls.length = 0;
  cameraDelay = () => 0;
  agentDelay = 1;
  const session = useSessionStore();
  session.me = {
    sub: 's', email: 'a@b.c', tenantId: 'acme', role: 'admin', premises: [],
  };
});

describe('a slow answer to an old question', () => {
  it('does not let an abandoned camera load overwrite the current one', async () => {
    // The premises has exactly one agent, so it auto-selects. The failure this
    // guards: a site-wide camera query issued alongside the agents, still in
    // flight when the agent settles, landing last because it is the bigger
    // query and writing its result over the one that was actually wanted.
    cameraDelay = (_p, agentId) => (agentId ? 1 : 20);

    const selection = useSelectionStore();
    await selection.loadCustomers();
    selection.premisesId = 'hq';
    await settled();

    // The site has one agent, so it settles and the only camera query worth
    // making is its own. Asking site-wide first fetched a page of rows that
    // were replaced a moment later.
    expect(calls).toEqual(['acme--hq--edge-01']);

    // And the grid shows that agent's cameras. When the abandoned site-wide
    // response was allowed to win, an operator watching one agent was shown
    // cameras belonging to another.
    expect(selection.agentId).toBe('acme--hq--edge-01');
    expect(selection.cameras.map((c) => c.cameraId)).toEqual(['cam-a']);
  });
});

describe('restoring a shared link', () => {
  it('lands on what the link named, and shows only that agent cameras', async () => {
    // The failure this guards: the link names an agent, the rail also issues a
    // site-wide camera query on its way there, and the site-wide answer — the
    // slower one, because it is the bigger one — arrives last and wins. The
    // operator opens a link to one agent and is shown another agent's cameras.
    cameraDelay = (_p, agentId) => (agentId ? 1 : 20);

    const selection = useSelectionStore();
    await selection.restore({
      premises: 'hq', agent: 'acme--hq--edge-01', camera: 'cam-a',
    });
    await settled();

    expect(selection.premisesId).toBe('hq');
    expect(selection.agentId).toBe('acme--hq--edge-01');
    expect(selection.cameraId).toBe('cam-a');
    expect(selection.cameras.map((c) => c.cameraId)).toEqual(['cam-a']);
  });

  it('does not ask the same question twice', async () => {
    // Every level was being loaded once by restore and once again by the
    // watcher its own assignment woke. At ten thousand cameras that is a
    // doubled bill and a doubled wait, on the path a shared link takes.
    const selection = useSelectionStore();
    await selection.restore({ premises: 'hq', agent: 'acme--hq--edge-01' });
    await settled();

    expect(calls).toEqual(['acme--hq--edge-01']);
  });
});

describe('changing your mind faster than the answer arrives', () => {
  it('shows the site you last picked, not the one that replied last', async () => {
    // An operator picks a site, sees it is the wrong one, and picks another
    // before the first has loaded. The abandoned query is the slow one — it is
    // slow because it is large — so without a guard it lands last and fills
    // the grid with cameras from a site the operator has already left.
    agentDelay = 0;
    cameraDelay = (premisesId) => (premisesId === 'depot' ? 30 : 1);

    const selection = useSelectionStore();
    await selection.loadCustomers();

    selection.premisesId = 'depot';
    // Long enough for the depot camera query to be in flight, not long enough
    // for it to have answered.
    for (let i = 0; i < 5; i += 1) await nextTick();
    expect(calls).toEqual(['all@depot']);

    selection.premisesId = 'annex';
    await settled();

    expect(selection.premisesId).toBe('annex');
    expect(selection.cameras.map((c) => c.cameraId)).toEqual(['annex-1', 'annex-2']);
  });
});
