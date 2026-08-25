import { currentSession } from './auth';
import { SessionSuperseded } from './api';

export type Role = 'superadmin' | 'admin' | 'operator' | 'viewer';
export type Platform = 'linux' | 'windows' | 'macos';

export interface Me {
  sub: string;
  email: string;
  tenantId: string;
  role: Role;
  premises: string[];
}

export interface Premises {
  premisesId: string;
  displayName: string;
  address?: string;
  createdAt: number;
}

export interface Agent {
  thingName: string;
  premisesId?: string;
  siteName?: string;
  agentVersion?: string;
  cameraCount: number;
  lastSeen?: number;
  /** From IoT presence events — the connection's actual state, not a poll. */
  online: boolean;
  disconnectReason?: string | null;
  taskHealth?: string[];
  /** Null until the agent has enrolled; credentials cannot be sent before then. */
  credentialPublicKey: string | null;
  enrolled: boolean;
}

export interface Sighting {
  thingName: string;
  premisesId?: string;
  ipAddress: string;
  authState: string;
  lastSeen: number;
  profiles: { token: string; name?: string; codec?: string; width?: number; height?: number; fps?: number }[];
}

export interface DiscoveredCamera {
  identity: string;
  identityStable: boolean;
  macAddress?: string;
  manufacturer?: string;
  model?: string;
  lastSeen: number;
  /** More than one entry means several agents can see this camera. */
  reachableBy: Sighting[];
  approved: { cameraId: string; displayName: string; assignedTo: string } | null;
}

export interface AdminUser {
  username: string;
  email?: string;
  tenantId?: string;
  premises?: string;
  role?: Role;
  status?: string;
  enabled?: boolean;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await currentSession();
  if (!session) throw new SessionSuperseded();

  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.headers ?? {}),
      'content-type': 'application/json',
      authorization: session.getIdToken().getJwtToken(),
    },
  });
  if (res.status === 409) throw new SessionSuperseded();
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keep the status code */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const whoAmI = () => call<Me>('/api/admin/me');
export const listPremises = () => call<{ premises: Premises[] }>('/api/admin/premises');
export const createPremises = (body: { premisesId: string; displayName: string; address?: string }) =>
  call<{ premisesId: string }>('/api/admin/premises', { method: 'POST', body: JSON.stringify(body) });
export const deletePremises = (premisesId: string) =>
  call<{ removed: string }>(`/api/admin/premises/${encodeURIComponent(premisesId)}`, { method: 'DELETE' });

export const listAgents = () => call<{ agents: Agent[] }>('/api/admin/agents');
export const createAgent = (body: { premisesId: string; deviceId: string; siteName?: string }) =>
  call<{ thingName: string; expiresAt: number }>('/api/admin/agents', { method: 'POST', body: JSON.stringify(body) });
export const requestScan = (thingName: string) =>
  call<{ requested: string }>('/api/admin/scan', { method: 'POST', body: JSON.stringify({ thingName }) });

/**
 * Downloads a ready-to-run installer for one agent and platform.
 *
 * Fetched rather than linked because the route needs an Authorization header,
 * and the response carries a single-use enrollment token — so it is handed
 * straight to the browser as a file and never cached.
 */
export async function downloadInstaller(thingName: string, platform: Platform): Promise<string> {
  const session = await currentSession();
  if (!session) throw new SessionSuperseded();

  const res = await fetch(
    `/api/admin/agents/${encodeURIComponent(thingName)}/installer?platform=${platform}`,
    { credentials: 'same-origin', headers: { authorization: session.getIdToken().getJwtToken() } },
  );
  if (res.status === 409) throw new SessionSuperseded();
  if (!res.ok) {
    let message = `${res.status}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* status only */ }
    throw new Error(message);
  }

  const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
    ?? `install-${thingName}.${platform === 'windows' ? 'ps1' : 'sh'}`;
  const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return filename;
}
export const listDiscovered = () => call<{ cameras: DiscoveredCamera[] }>('/api/admin/discovered');
export const listUsers = () => call<{ users: AdminUser[] }>('/api/admin/users');

export const approveCamera = (body: {
  identity: string;
  assignedTo: string;
  displayName: string;
  cameraId?: string;
  subProfileToken?: string;
  mainProfileToken?: string;
  sourceCodec?: string;
}) => call<{ approved: string }>('/api/admin/cameras', { method: 'POST', body: JSON.stringify(body) });

export const removeCamera = (identity: string) =>
  call<{ removed: string }>(`/api/admin/cameras/${encodeURIComponent(identity)}`, { method: 'DELETE' });

/** `ciphertext` must already be sealed for the target agent — see crypto.ts. */
export const storeCredential = (body: { thingName: string; scope: string; ciphertext: string }) =>
  call<{ stored: string }>('/api/admin/credentials', { method: 'POST', body: JSON.stringify(body) });

export const createUser = (body: { email: string; role: Role; premises?: string[] }) =>
  call<{ created: string }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });

export const deleteUser = (username: string) =>
  call<{ deleted: string }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });

const MANAGE_ROLES: Role[] = ['superadmin', 'admin', 'operator'];

/** Whether this account may reach the administration screens at all. */
export async function canAdminister(): Promise<boolean> {
  const session = await currentSession();
  if (!session) return false;
  const groups = session.getIdToken().payload['cognito:groups'];
  return Array.isArray(groups) && groups.some((g) => MANAGE_ROLES.includes(g as Role));
}
