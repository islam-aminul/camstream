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
  manifestUrl: { sub: string; main: string; subH264: string; mainH264: string; master: string };
}

/**
 * Whether a transcoded rendition would actually help.
 *
 * Mirrors the control plane's rule exactly. H.264 is the universal floor, so a
 * camera already emitting it has no better variant to offer — asking for one
 * yields a path the agent is never told to publish, and the player waits on a
 * 403 forever. A browser that cannot decode H.264 cannot be helped by
 * transcoding to H.264.
 */
export function transcodeWouldHelp(camera: Camera): boolean {
  const codec = (camera.sourceCodec ?? 'h264').toLowerCase();
  if (codec === 'h264' || codec === 'avc' || codec === 'avc1') {
    return false;
  }
  return supports('h264');
}

/** Whether this browser can decode what the camera actually emits. */
export function playsNatively(camera: Camera): boolean {
  return supports(camera.sourceCodec ?? 'h264');
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
export function watch(
  sessionId: string,
  grid: boolean,
  main?: { thingName: string; cameraId: string },
  transcode: string[] = [],
): Promise<WatchResult> {
  return call<WatchResult>('/api/watch', {
    method: 'POST',
    // Capabilities let the agent skip encoding for viewers who do not need it;
    // `transcode` names the cameras a viewer has explicitly asked it to encode
    // anyway, so nothing is spent on inference.
    body: JSON.stringify({ sessionId, grid, main, codecs: supportedCodecs(), transcode }),
  });
}
