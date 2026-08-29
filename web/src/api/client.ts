import { currentSession } from './auth';

/** Thrown when this browser's session has been displaced by a newer sign-in. */
export class SessionSuperseded extends Error {
  constructor() {
    super('Signed in from another device or tab');
    this.name = 'SessionSuperseded';
  }
}

/** A refusal the caller can act on, carrying what the server actually said. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every call carries the ID token rather than the access token.
 *
 * The control plane authorises on `custom:tenantId` and `cognito:groups`, and
 * custom attributes appear only in the ID token — an access token would
 * authenticate and then be refused by every route.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await currentSession();
  if (!session) throw new SessionSuperseded();

  const res = await fetch(path, {
    ...init,
    // Same-origin, but stated: the CloudFront cookies must ride along.
    credentials: 'same-origin',
    headers: {
      ...(init.headers ?? {}),
      'content-type': 'application/json',
      authorization: session.getIdToken().getJwtToken(),
    },
  });

  if (res.status === 409) throw new SessionSuperseded();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? `${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Drops empty values so an absent filter never reaches the server as "". */
function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const get = <T>(path: string, params: Record<string, string | number | undefined | null> = {}) =>
  request<T>(`${path}${query(params)}`);

export const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const del = <T>(path: string, params: Record<string, string | undefined> = {}) =>
  request<T>(`${path}${query(params)}`, { method: 'DELETE' });
