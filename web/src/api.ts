import { currentSession } from './auth';
import { supportedCodecs, supports } from './codecs';

export interface Camera {
  thingName: string;
  cameraId: string;
  displayName: string;
  resolution?: string;
  online: boolean;
  profiles: string[];
  /** Codec the camera emits natively. */
  sourceCodec: string;
  /**
   * The codec profile, where the agent could determine it.
   *
   * Carried separately because it decides playability on its own: H.264 High
   * 10 reports the same codec name as the H.264 every browser decodes.
   */
  sourceCodecProfile?: string | null;
  /** Grouping keys, so the console can bifurcate an estate without parsing ids. */
  premisesId?: string | null;
  siteName?: string | null;
  /** Where it is on the customer's network, and its hardware address. */
  ipAddress?: string | null;
  macAddress?: string | null;
  resolutionLabel?: string;
  manifestUrl: { sub: string; main: string; subH264: string; mainH264: string; master: string };
}

/**
 * H.264 profiles that carry the codec name but no browser support.
 *
 * The 10-bit and higher-chroma variants. A camera emitting one of these calls
 * itself H.264 in its own web UI, reports h264 over ONVIF, and is decoded by
 * nothing — which is precisely why the codec name cannot be the whole test.
 *
 * Mirrors `lambda/shared/playability.ts`; the two are separate builds, and a
 * divergence shows up as a viewer being offered a rendition the control plane
 * declines to publish.
 */
const UNPLAYABLE_H264_PROFILES = new Set([
  'high 10',
  'high 10 intra',
  'high 4:2:2',
  'high 4:2:2 intra',
  'high 4:4:4 predictive',
  'high 4:4:4 intra',
  'cavlc 4:4:4',
]);

function isH264(codec: string | undefined): boolean {
  const value = (codec ?? 'h264').toLowerCase();
  return value === 'h264' || value === 'avc' || value === 'avc1';
}

/**
 * An unrecognised profile counts as playable: guessing the other way would
 * transcode streams that never needed it, spending the customer's edge CPU.
 */
function isUnplayableH264(camera: Camera): boolean {
  return (
    isH264(camera.sourceCodec)
    && UNPLAYABLE_H264_PROFILES.has((camera.sourceCodecProfile ?? '').toLowerCase().trim())
  );
}

/** Whether this browser can decode what the camera actually emits. */
export function playsNatively(camera: Camera): boolean {
  if (isH264(camera.sourceCodec)) {
    // Ordinary H.264 is the universal floor; the exotic profiles are in
    // nobody's supported list, whatever their codec name suggests.
    return !isUnplayableH264(camera);
  }
  return supports(camera.sourceCodec ?? 'h264');
}

/**
 * Whether a transcoded rendition would actually help.
 *
 * The agent transcodes to 8-bit H.264, so it helps exactly when this browser
 * can decode that and cannot decode the source. A browser that cannot decode
 * H.264 at all cannot be helped by transcoding to H.264.
 */
export function transcodeWouldHelp(camera: Camera): boolean {
  if (playsNatively(camera)) {
    return false;
  }
  return supports('h264');
}

/**
 * The URL to load.
 *
 * `transcoded` is the viewer's own decision, not an inference: transcoding
 * spends CPU at the customer's edge, so it is offered rather than applied.
 */
export function manifestFor(camera: Camera, profile: 'sub' | 'main', transcoded: boolean): string {
  if (transcoded) {
    return profile === 'main' ? camera.manifestUrl.mainH264 : camera.manifestUrl.subH264;
  }
  // The master playlist exists only while both rungs are publishing, which is
  // exactly what opening the camera causes — so the detail view can take the
  // ladder and drop to the sub stream on a poor connection.
  return profile === 'main' ? camera.manifestUrl.master : camera.manifestUrl.sub;
}

export interface SessionInfo {
  sessionId: string;
  tenantId: string;
  expiresAt: number;
  refreshInSeconds: number;
  displacedPreviousSession: boolean;
}

export interface WatchResult {
  keepaliveInSeconds: number;
  desired?: {
    thingName: string;
    declined?: { cameraId: string; profile: 'sub' | 'main' }[];
    maxConcurrentTranscodes?: number;
  }[];
}

/** A transcode the site has no free slot to run. */
export interface DeclinedTranscode {
  cameraId: string;
  limit: number;
}

/**
 * Transcodes the control plane turned away, flattened for the client.
 *
 * Without this a capped transcode looks exactly like a broken one: the
 * rendition never appears, the player waits out its retries, and the camera is
 * reported as not being published — which sends the viewer looking for a fault
 * that does not exist.
 */
export function declinedTranscodes(result: WatchResult): DeclinedTranscode[] {
  const out = new Map<string, DeclinedTranscode>();
  for (const state of result.desired ?? []) {
    for (const entry of state.declined ?? []) {
      out.set(entry.cameraId, {
        cameraId: entry.cameraId,
        limit: state.maxConcurrentTranscodes ?? 1,
      });
    }
  }
  return [...out.values()];
}

/** Thrown when this browser's session has been displaced by a newer sign-in. */
export class SessionSuperseded extends Error {
  constructor() {
    super('Signed in from another device or tab');
    this.name = 'SessionSuperseded';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await currentSession();
  if (!session) throw new SessionSuperseded();

  const res = await fetch(path, {
    ...init,
    // Same-origin, but stated explicitly: the CloudFront cookies must ride along.
    credentials: 'same-origin',
    headers: {
      ...(init.headers ?? {}),
      'content-type': 'application/json',
      authorization: session.getIdToken().getJwtToken(),
    },
  });

  if (res.status === 409) throw new SessionSuperseded();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${path} failed: ${res.status} ${detail}`.trim());
  }
  return res.json() as Promise<T>;
}

/**
 * Exchanges the Cognito token for CloudFront cookies.
 *
 * Called with no sessionId to claim the tenant's single session slot, and with
 * one to refresh in place. A refresh that has lost the slot returns 409.
 */
export function startSession(sessionId?: string): Promise<SessionInfo> {
  return call<SessionInfo>('/api/session', {
    method: 'POST',
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  });
}

export function listCameras(): Promise<{ cameras: Camera[] }> {
  return call<{ cameras: Camera[] }>('/api/streams');
}

/**
 * Declares what this viewer currently has open. Agents publish only what is
 * asked for here, so this call is what starts and stops the cameras — and the
 * billing.
 */
/**
 * Tells the control plane what this viewer is showing.
 *
 * `visible` is the cameras actually on screen, as "thingName/cameraId" — not
 * "the grid is open". Every published rendition is an ffmpeg process at the
 * customer's edge and S3 requests per segment, so a site with a thousand
 * cameras must not start a thousand streams because somebody opened a page.
 */
export function watch(
  sessionId: string,
  visible: string[],
  main?: { thingName: string; cameraId: string },
  transcode: string[] = [],
): Promise<WatchResult> {
  return call<WatchResult>('/api/watch', {
    method: 'POST',
    // Capabilities let the agent skip encoding for viewers who do not need it;
    // `transcode` names the cameras a viewer has explicitly asked it to encode
    // anyway, so nothing is spent on inference.
    body: JSON.stringify({ sessionId, visible, main, codecs: supportedCodecs(), transcode }),
  });
}

/** The key a camera is named by everywhere demand is expressed. */
export function cameraKey(camera: { thingName: string; cameraId: string }): string {
  return `${camera.thingName}/${camera.cameraId}`;
}
