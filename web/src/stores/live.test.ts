import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';

/**
 * The live view's store, exercised where the money is: what gets rendered,
 * what gets declared as demand, and what happens when the page goes away.
 */

const cameraCalls: Record<string, unknown>[] = [];
const watchCalls: Record<string, unknown>[] = [];
const sessionCalls: { sessionId?: string; premisesId?: string }[] = [];
let registered: { cameraId: string; displayName: string; assignedTo: string }[] = [];
/** Cameras an agent has actually reported — a subset, often a strict one. */
let reported: string[] = [];

vi.mock('@/api', () => ({
  api: {
    customers: () => Promise.resolve([{ tenantId: 'acme', displayName: 'Acme' }]),
    premises: () => Promise.resolve([{ premisesId: 'hq', displayName: 'HQ' }]),
    agents: () => Promise.resolve({ total: 0, items: [] }),
    cameras: (p: Record<string, unknown>) => {
      cameraCalls.push(p);
      const all = p.cameraId
        ? registered.filter((c) => c.cameraId === p.cameraId)
        : registered;
      const from = p.cursor ? Number(p.cursor) : 0;
      const limit = Number(p.limit ?? 50);
      const items = all.slice(from, from + limit);
      const next = from + limit < all.length ? String(from + limit) : undefined;
      return Promise.resolve({ total: all.length, cursor: next, items });
    },
    streams: (p: { cameraIds: string[] }) => Promise.resolve(
      p.cameraIds.filter((id) => reported.includes(id)).map((id) => ({
        thingName: 'acme--hq--edge-01',
        cameraId: id,
        displayName: id,
        online: true,
        premisesId: 'hq',
        siteName: 'HQ',
        profiles: ['sub'],
        sourceCodec: 'h264',
        sourceCodecProfile: 'Main',
        manifestUrl: {
          sub: `/live/acme--hq--edge-01/${id}/sub/index.m3u8`,
          main: '', subH264: '', mainH264: '', master: '',
        },
      })),
    ),
    // Re-cutting the video cookie to the site being watched, which the store
    // does before it hands any manifest to a player.
    session: (sessionId?: string, premisesId?: string) => {
      sessionCalls.push({ sessionId, premisesId });
      return Promise.resolve({
        sessionId: 'sess-1', tenantId: 'acme', expiresAt: 0,
        refreshInSeconds: 240, displacedPreviousSession: false, scope: '',
      });
    },
    me: () => Promise.resolve({
      sub: 's', email: 'a@b.c', tenantId: 'acme', role: 'admin', premises: [],
    }),
    watch: (body: Record<string, unknown>) => {
      watchCalls.push(body);
      return Promise.resolve({ keepaliveInSeconds: 30, desired: [] });
    },
  },
}));

/**
 * A minimal localStorage. The store guards every access, so this exists to
 * exercise the remembering rather than to make the store work — a browser that
 * refuses storage must still run, and that is asserted separately below.
 */
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});

const { useLiveStore } = await import('./live');
const { useSelectionStore } = await import('./selection');
const { useSessionStore } = await import('./session');

async function settled() {
  for (let i = 0; i < 40; i += 1) await nextTick();
}

function camera(n: number) {
  const id = `cam-${String(n).padStart(4, '0')}`;
  return { cameraId: id, displayName: `Camera ${n}`, assignedTo: 'acme--hq--edge-01' };
}

beforeEach(() => {
  setActivePinia(createPinia());
  cameraCalls.length = 0;
  watchCalls.length = 0;
  sessionCalls.length = 0;
  registered = Array.from({ length: 30 }, (_, i) => camera(i + 1));
  reported = registered.map((c) => c.cameraId);
  localStorage.clear();

  const session = useSessionStore();
  session.me = { sub: 's', email: 'a@b.c', tenantId: 'acme', role: 'admin', premises: [] };
  session.info = {
    sessionId: 'sess-1', tenantId: 'acme', expiresAt: 0,
    refreshInSeconds: 240, displacedPreviousSession: false, scope: '',
  };
  const selection = useSelectionStore();
  selection.customerId = 'acme';
  selection.premisesId = 'hq';
});

describe('what the grid renders', () => {
  it('fetches exactly one screenful, not the site', async () => {
    // The endpoint this replaced tried to return every camera at a site and
    // outgrew what a Lambda may return at around seven thousand of them.
    const live = useLiveStore();
    live.tiles = 9;
    await live.first();
    await settled();

    expect(live.entries).toHaveLength(9);
    expect(live.total).toBe(30);
    expect(cameraCalls.at(-1)).toMatchObject({ limit: 9 });
  });

  it('shows a registered camera its agent has never reported', async () => {
    // The seeded estate is exactly this: cameras in the registry, no agent
    // having reported one. Rendering only what has a manifest would have shown
    // an empty wall and no reason for it.
    reported = [];
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    expect(live.entries).toHaveLength(4);
    expect(live.entries.every((e) => e.stream === undefined)).toBe(true);
    expect(live.entries[0]!.key).toBe('acme--hq--edge-01/cam-0001');
  });

  it('joins each camera to its own manifest', async () => {
    reported = ['cam-0002'];
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    expect(live.entries.map((e) => e.stream?.cameraId)).toEqual([
      undefined, 'cam-0002', undefined, undefined,
    ]);
  });
});

describe('paging a site too large to hold', () => {
  it('steps forward and back by cursor', async () => {
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();
    expect(live.entries[0]!.camera.cameraId).toBe('cam-0001');
    expect(live.hasPrevious).toBe(false);
    expect(live.hasNext).toBe(true);

    await live.next();
    await settled();
    expect(live.entries[0]!.camera.cameraId).toBe('cam-0005');
    expect([live.from, live.to]).toEqual([5, 8]);

    await live.previous();
    await settled();
    expect(live.entries[0]!.camera.cameraId).toBe('cam-0001');
  });

  it('stops offering a next page at the end', async () => {
    registered = [camera(1), camera(2)];
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();
    expect(live.hasNext).toBe(false);
  });

  it('shows one chosen camera on its own, without paging to find it', async () => {
    // Searching for a camera in the rail lands here. There is no cursor that
    // opens the page it happens to be on, and an operator who searched for one
    // name is asking to see that camera.
    const selection = useSelectionStore();
    selection.cameraId = 'cam-0017';
    const live = useLiveStore();
    await live.first();
    await settled();

    expect(live.pinnedToOne).toBe(true);
    expect(live.entries.map((e) => e.camera.cameraId)).toEqual(['cam-0017']);
    expect(cameraCalls.at(-1)).toMatchObject({ cameraId: 'cam-0017', limit: 1 });
  });
});

describe('what it tells the control plane to publish', () => {
  it('declares only the cameras on screen', async () => {
    // Each entry is an ffmpeg process at the site and a stream of uploads.
    // Demand is a screenful, never an estate.
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    const last = watchCalls.at(-1)!;
    expect(last.visible).toEqual([
      'acme--hq--edge-01/cam-0001',
      'acme--hq--edge-01/cam-0002',
      'acme--hq--edge-01/cam-0003',
      'acme--hq--edge-01/cam-0004',
    ]);
    expect(last).toMatchObject({ sessionId: 'sess-1', premisesId: 'hq' });
  });

  it('does not ask for a camera that has no stream to ask for', async () => {
    reported = ['cam-0003'];
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    expect(watchCalls.at(-1)!.visible).toEqual(['acme--hq--edge-01/cam-0003']);
  });

  it('gives everything up when the page goes away', async () => {
    // Demand expires on its own within a minute, but a minute of ffmpeg per
    // navigation is a real cost on somebody's hardware.
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    await live.release();
    expect(watchCalls.at(-1)).toMatchObject({ visible: [], transcode: [] });
  });

  it('carries a requested conversion into the next declaration', async () => {
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    live.requestTranscode('acme--hq--edge-01/cam-0002');
    await settled();
    expect(watchCalls.at(-1)!.transcode).toEqual(['acme--hq--edge-01/cam-0002']);

    live.stopTranscode('acme--hq--edge-01/cam-0002');
    await settled();
    expect(watchCalls.at(-1)!.transcode).toEqual([]);
  });

  it('reports the browser codecs so the site never transcodes on a guess', async () => {
    const live = useLiveStore();
    await live.first();
    await settled();
    expect(watchCalls.at(-1)!.codecs).toContain('h264');
  });
});

describe('changing the tile count', () => {
  it('returns to the first page, because the cursors no longer mean anything', async () => {
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();
    await live.next();
    await settled();
    expect(live.page).toBe(1);

    live.setTiles(9);
    await settled();
    expect(live.page).toBe(0);
    expect(live.entries).toHaveLength(9);
  });

  it('remembers the choice for next time', async () => {
    const live = useLiveStore();
    live.setTiles(16);
    await settled();
    expect(localStorage.getItem('camstream.tiles')).toBe('16');
  });

  it('still changes the count when the browser refuses to remember it', async () => {
    // Private windows and blocked site data both throw here. Refusing the
    // change because it cannot be written down would be the wrong trade.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      clear: () => {},
    });
    const live = useLiveStore();
    live.setTiles(12);
    await settled();
    expect(live.tiles).toBe(12);
    expect(live.entries).toHaveLength(12);
  });
});

describe('the cookies that authorise the video', () => {
  it('cuts them to the site being watched, before any manifest is played', async () => {
    // A CloudFront cookie is a bearer token for video. One scoped to a whole
    // customer is one that leaks a whole customer, so it is re-cut to the site
    // on screen — and re-cut before a player is handed a URL, or the fetch is
    // refused and the tile stalls with nothing to explain it.
    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    expect(sessionCalls.at(-1)).toMatchObject({ premisesId: 'hq' });
  });

  it('still shows the estate when the cookie cannot be re-cut', async () => {
    // Video will not play, but an empty page tells the operator nothing. The
    // list loads and says why the video will not.
    const session = useSessionStore();
    session.watch = () => Promise.reject(new Error('network down'));

    const live = useLiveStore();
    live.tiles = 4;
    await live.first();
    await settled();

    expect(live.entries).toHaveLength(4);
    expect(live.error).toContain('Could not authorise video');
  });
});
