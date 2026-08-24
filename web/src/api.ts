import { currentSession } from './auth';

export interface Camera {
  thingName: string;
  cameraId: string;
  displayName: string;
  resolution?: string;
  online: boolean;
  profiles: string[];
  manifestUrl: { sub: string; main: string };
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
    body: JSON.stringify({ sessionId, grid, main }),
  });
}
