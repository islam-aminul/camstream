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
  manifestUrl: { sub: string; main: string; subH264: string; mainH264: string };
}

/**
 * The URL this browser should actually load: the camera's own stream when it
 * can decode it, the transcoded one only when it cannot.
 */
export function manifestFor(camera: Camera, profile: 'sub' | 'main'): string {
  const native = supports(camera.sourceCodec ?? 'h264');
  if (profile === 'main') {
    return native ? camera.manifestUrl.main : camera.manifestUrl.mainH264;
  }
  return native ? camera.manifestUrl.sub : camera.manifestUrl.subH264;
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
): Promise<WatchResult> {
  return call<WatchResult>('/api/watch', {
    method: 'POST',
    // Declaring capabilities here is what lets the agent skip encoding for
    // viewers who do not need it.
    body: JSON.stringify({ sessionId, grid, main, codecs: supportedCodecs() }),
  });
}
