import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { api, type Camera, type Stream, type DesiredState } from '@/api';
import { useSelectionStore } from './selection';
import { useSessionStore } from './session';
import { createLatest } from './cascade';
import { MAX_TILES, TILE_CHOICES } from './grid';
import { browserCodecs } from '@/player/playability';

const TILES_KEY = 'camstream.tiles';

/**
 * The live view's own state: which page of cameras is on screen, what the
 * agents have been asked to publish, and the keepalive that keeps it true.
 *
 * Two things make this different from an ordinary list:
 *
 * Paging is by cursor, not by offset. A site can hold ten thousand cameras and
 * DynamoDB pages forward from a key; there is no page seven to jump to. So the
 * view offers first, previous and next, which is the honest shape of what the
 * store underneath can do, and each page is fetched at exactly the size of the
 * grid rather than fetched large and sliced.
 *
 * And what is on screen is a *bill*. Each tile is an ffmpeg rendition running
 * on the customer's hardware and a stream of uploads to S3, so the set of
 * visible cameras is posted to the control plane and re-posted on a keepalive.
 * Stop posting — close the tab, navigate away — and the streams stop within a
 * minute on their own.
 */
export const useLiveStore = defineStore('live', () => {
  const selection = useSelectionStore();
  const session = useSessionStore();
  const latest = createLatest();

  /** Tiles per page, remembered per browser. */
  const tiles = ref<number>(readTiles());
  const cameras = ref<Camera[]>([]);
  const streams = ref<Stream[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * One cursor per page boundary crossed. Index 0 is the first page, which
   * needs no cursor; entry n is the key that opens page n.
   */
  const cursors = ref<(string | undefined)[]>([undefined]);
  const page = ref(0);
  const nextCursor = ref<string | undefined>(undefined);

  /** Cameras the viewer has explicitly asked the agent to convert. */
  const transcode = ref<Set<string>>(new Set());
  /** The one camera opened full size, which is the only main-stream demand. */
  const main = ref<{ thingName: string; cameraId: string } | null>(null);

  const desired = ref<DesiredState[]>([]);
  const codecs = browserCodecs();

  let keepalive: ReturnType<typeof setInterval> | undefined;

  const hasPrevious = computed(() => page.value > 0);
  const hasNext = computed(() => nextCursor.value !== undefined);
  const from = computed(() => (total.value === 0 ? 0 : page.value * tiles.value + 1));
  const to = computed(() => page.value * tiles.value + cameras.value.length);
  /** True while the rail has narrowed the grid to a single chosen camera. */
  const pinnedToOne = computed(() => Boolean(selection.cameraId));

  /**
   * What the grid actually renders: the registered cameras of this page, each
   * with its manifest if the agent has ever reported it.
   *
   * Driven by the camera list rather than by the manifests, because the two
   * are not the same set. A camera can be registered and never seen — added to
   * an agent that cannot reach it, or given the wrong credentials — and it has
   * no manifest at all. Rendering only what has manifests would make exactly
   * the cameras somebody is troubleshooting the ones that vanish.
   */
  const entries = computed(() => {
    const byId = new Map(streams.value.map((s) => [s.cameraId, s]));
    return cameras.value.map((camera) => ({
      camera,
      stream: byId.get(camera.cameraId),
      key: `${camera.assignedTo}/${camera.cameraId}`,
    }));
  });

  /** "thingName/cameraId" for every camera on screen — the unit of demand. */
  const visible = computed(() =>
    streams.value.map((s) => `${s.thingName}/${s.cameraId}`));

  /**
   * What each agent was asked for, so a tile can tell "starting" from "stuck".
   */
  const demandedFor = computed(() => {
    const set = new Set<string>();
    for (const state of desired.value) {
      for (const r of state.renditions) set.add(`${state.thingName}/${r.cameraId}`);
    }
    return set;
  });

  const declinedFor = computed(() => {
    const map = new Map<string, number | undefined>();
    for (const state of desired.value) {
      for (const d of state.declined ?? []) {
        map.set(`${state.thingName}/${d.cameraId}`, state.maxConcurrentTranscodes);
      }
    }
    return map;
  });

  /** How many renditions each agent is currently carrying, for the ceiling. */
  const streamsPerAgent = computed(() => {
    const map = new Map<string, number>();
    for (const state of desired.value) map.set(state.thingName, state.renditions.length);
    return map;
  });

  function setTiles(count: number) {
    const chosen = TILE_CHOICES.includes(count as (typeof TILE_CHOICES)[number])
      ? count : Math.min(MAX_TILES, Math.max(1, count));
    tiles.value = chosen;
    try {
      localStorage.setItem(TILES_KEY, String(chosen));
    } catch {
      // A browser refusing storage is not a reason to refuse the change.
    }
    void first();
  }

  /**
   * Loads the page named by the current cursor, then its manifests.
   *
   * Two calls rather than one because they answer different questions and have
   * different limits: the camera list pages a site of any size, and the stream
   * manifests are fetched only for what is on screen — asking for a site's
   * worth of them is what once outgrew a Lambda response.
   */
  async function loadPage() {
    if (!selection.premisesId) { cameras.value = []; streams.value = []; return; }
    const ticket = latest.begin('page');
    loading.value = true;
    // Cleared here rather than on success: a problem found part way through —
    // the video cookie failing to re-cut, say — must survive the rest of the
    // load rather than being wiped by it.
    error.value = null;
    try {
      // Before any manifest reaches a player. The video cookies are cut to one
      // site, so a player started against the old cookie would be refused by
      // CloudFront and show a stall with no way to explain itself.
      //
      // Reported rather than fatal: if the cookie cannot be re-cut the video
      // will not play, but the operator should still see the estate and the
      // reason, not an empty page.
      await session.watch(selection.premisesId, selection.tenantParam).catch((err: Error) => {
        error.value = `Could not authorise video for this site: ${err.message}`;
      });
      // A camera chosen in the rail — including by searching for its name — is
      // shown on its own. Paging to it would need a cursor nobody holds, and
      // somebody who just searched for one name is asking to see that camera,
      // not to be told which page of the wall it is on.
      const result = selection.cameraId
        ? await api.cameras({
          tenantId: selection.tenantParam,
          premisesId: selection.premisesId,
          agentId: selection.agentId ?? undefined,
          cameraId: selection.cameraId,
          limit: 1,
        })
        : await api.cameras({
          tenantId: selection.tenantParam,
          premisesId: selection.premisesId,
          agentId: selection.agentId ?? undefined,
          cursor: cursors.value[page.value],
          limit: tiles.value,
        });
      if (!latest.current('page', ticket)) return;

      cameras.value = result.items;
      total.value = result.total;
      nextCursor.value = result.cursor;
      // Record the key that opens the following page, so "next" is a step
      // rather than a re-scan from the beginning.
      if (result.cursor) cursors.value[page.value + 1] = result.cursor;

      const manifests = result.items.length
        ? await api.streams({
          tenantId: selection.tenantParam,
          premisesId: selection.premisesId,
          cameraIds: result.items.map((c) => c.cameraId),
        })
        : [];
      if (!latest.current('page', ticket)) return;
      streams.value = manifests;
      await declare();
    } catch (err) {
      if (latest.current('page', ticket)) error.value = (err as Error).message;
    } finally {
      if (latest.current('page', ticket)) loading.value = false;
    }
  }

  async function first() { page.value = 0; cursors.value = [undefined]; await loadPage(); }
  async function next() {
    if (!hasNext.value) return;
    page.value += 1;
    await loadPage();
  }
  async function previous() {
    if (!hasPrevious.value) return;
    page.value -= 1;
    await loadPage();
  }

  /**
   * Tells the control plane what is on screen.
   *
   * This is the call that starts and stops streams. It is posted whenever the
   * visible set changes and repeated on the interval the server names, because
   * demand expires: the agent stops publishing anything nobody has asked for
   * in the last minute, which is what makes closing a tab free.
   */
  async function declare() {
    const sessionId = session.info?.sessionId;
    if (!sessionId || !selection.premisesId) return;
    try {
      const response = await api.watch({
        sessionId,
        premisesId: selection.premisesId,
        visible: visible.value,
        main: main.value ?? undefined,
        codecs,
        transcode: [...transcode.value],
      });
      desired.value = response.desired;
      schedule(response.keepaliveInSeconds);
    } catch (err) {
      error.value = (err as Error).message;
    }
  }

  function schedule(seconds: number) {
    if (keepalive) clearInterval(keepalive);
    keepalive = setInterval(() => { void declare(); }, Math.max(5, seconds) * 1000);
  }

  /**
   * Gives up every stream this viewer was holding.
   *
   * Called when the live view goes away. Demand would expire on its own within
   * a minute, but a minute of ffmpeg per navigation is a real cost and an
   * explicit release is one request.
   */
  async function release() {
    if (keepalive) clearInterval(keepalive);
    keepalive = undefined;
    transcode.value = new Set();
    main.value = null;
    const sessionId = session.info?.sessionId;
    if (!sessionId || !selection.premisesId) return;
    await api.watch({
      sessionId,
      premisesId: selection.premisesId,
      visible: [],
      codecs,
      transcode: [],
    }).catch(() => {
      // Best effort. The TTL is the real guarantee.
    });
  }

  /** Asks the agent to convert one camera, at the cost of a slot and its CPU. */
  function requestTranscode(key: string) {
    transcode.value = new Set([...transcode.value, key]);
    void declare();
  }

  function stopTranscode(key: string) {
    const next = new Set(transcode.value);
    next.delete(key);
    transcode.value = next;
    void declare();
  }

  function openMain(target: { thingName: string; cameraId: string } | null) {
    main.value = target;
    void declare();
  }

  // A change of site, agent or chosen camera restarts the paging: the cursors
  // belong to the query that produced them and mean nothing against another.
  watch(
    () => [selection.premisesId, selection.agentId, selection.cameraId],
    () => { void first(); },
  );

  return {
    tiles, cameras, streams, entries, total, loading, error,
    page, hasPrevious, hasNext, from, to, pinnedToOne,
    desired, demandedFor, declinedFor, streamsPerAgent, transcode, main, codecs,
    setTiles, loadPage, first, next, previous, declare, release,
    requestTranscode, stopTranscode, openMain,
  };
});

function readTiles(): number {
  try {
    const stored = Number(localStorage.getItem(TILES_KEY));
    if (TILE_CHOICES.includes(stored as (typeof TILE_CHOICES)[number])) return stored;
  } catch {
    // Private windows and blocked storage both land here; the default is fine.
  }
  return 9;
}
