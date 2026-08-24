import { currentSession } from './auth';
import { SessionSuperseded } from './api';

export interface Agent {
  thingName: string;
  siteName?: string;
  agentVersion?: string;
  cameraCount: number;
  lastSeen?: number;
  online: boolean;
  /** Null until the agent has reported one; credentials cannot be sent before then. */
  credentialPublicKey: string | null;
}

export interface Sighting {
  thingName: string;
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

export const listAgents = () => call<{ agents: Agent[] }>('/api/admin/agents');
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

export const createUser = (body: { email: string; admin: boolean }) =>
  call<{ created: string }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });

export const deleteUser = (username: string) =>
  call<{ deleted: string }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });

/** Whether the signed-in account carries the admin group claim. */
export async function isAdmin(): Promise<boolean> {
  const session = await currentSession();
  if (!session) return false;
  const groups = session.getIdToken().payload['cognito:groups'];
  return Array.isArray(groups) && groups.includes('admin');
}
