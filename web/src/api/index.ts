import { get, post } from './client';

export type Role = 'superadmin' | 'admin' | 'operator' | 'viewer';

export interface Me {
  sub: string;
  email: string;
  tenantId: string;
  role: Role;
  /** Sites this account may see. Empty means every site in its customer. */
  premises: string[];
}

export interface Customer { tenantId: string; displayName: string; createdAt: number }
export interface Premises { premisesId: string; displayName: string; address?: string }

export interface Agent {
  thingName: string;
  premisesId?: string;
  siteName?: string;
  agentVersion?: string;
  cameraCount: number;
  online: boolean;
  enrolled: boolean;
  credentialPublicKey: string | null;
  maxConcurrentTranscodes: number;
  health?: { at: number | null; healthy: boolean; failingTasks: string[]; publishing: number } | null;
}

export interface Camera {
  identity: string;
  cameraId: string;
  displayName: string;
  assignedTo: string;
  sourceCodec: string | null;
  publishing: boolean;
}

/** A page, plus how many matched and where to resume. */
export interface Page<T> { total: number; cursor?: string; items: T[] }

export interface SessionInfo {
  sessionId: string;
  tenantId: string;
  expiresAt: number;
  refreshInSeconds: number;
  displacedPreviousSession: boolean;
  scope: string;
}

export const api = {
  me: () => get<Me>('/api/admin/me'),

  session: (sessionId?: string) =>
    post<SessionInfo>('/api/session', sessionId ? { sessionId } : {}),

  customers: () =>
    get<{ customers: Customer[] }>('/api/admin/customers').then((r) => r.customers),

  createCustomer: (displayName: string) =>
    post<Customer>('/api/admin/customers', { displayName }),

  premises: (tenantId?: string) =>
    get<{ premises: Premises[] }>('/api/admin/premises', { tenantId }).then((r) => r.premises),

  agents: (p: { tenantId?: string; premisesId: string; q?: string; cursor?: string; limit?: number }) =>
    get<{ total: number; cursor?: string; agents: Agent[] }>('/api/admin/agents', p)
      .then((r): Page<Agent> => ({ total: r.total, cursor: r.cursor, items: r.agents })),

  cameras: (p: {
    tenantId?: string; premisesId: string; agentId?: string;
    q?: string; status?: string; cursor?: string; limit?: number;
  }) =>
    get<{ total: number; cursor?: string; cameras: Camera[] }>('/api/admin/cameras', p)
      .then((r): Page<Camera> => ({ total: r.total, cursor: r.cursor, items: r.cameras })),

  counts: (p: { tenantId?: string; premisesId?: string }) =>
    get<{ agents?: number; cameras?: number; discovered?: number; premises?: number }>(
      '/api/admin/counts', p),

  search: (p: { tenantId?: string; premisesId?: string; q: string }) =>
    get<{
      premises: Premises[];
      agents: { thingName: string; siteName?: string; premisesId: string }[];
      cameras: { identity: string; cameraId: string; displayName: string; premisesId: string }[];
      searchedSites: number;
    }>('/api/admin/search', p),
};
