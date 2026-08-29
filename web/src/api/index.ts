import { get, post, patch, del } from './client';

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

export interface User {
  username: string;
  email: string;
  tenantId?: string;
  /** Sites this account may see; empty means every site in its customer. */
  premises: string;
  role: Role;
  status?: string;
  enabled?: boolean;
}
export interface Premises { premisesId: string; displayName: string; address?: string }

export interface Agent {
  thingName: string;
  premisesId?: string;
  siteName?: string;
  agentVersion?: string;
  /** Cameras assigned to this agent — what its capacity is measured against. */
  cameraCount: number;
  /** What the agent itself last reported handling; 0 until it connects. */
  reportedCameras?: number;
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


/** A camera as the live view needs it: where to fetch it and what it emits. */
export interface Stream {
  thingName: string;
  cameraId: string;
  displayName: string;
  resolution?: string;
  lastSeen?: number;
  online: boolean;
  premisesId: string | null;
  siteName: string | null;
  profiles: string[];
  sourceCodec: string;
  sourceCodecProfile: string | null;
  manifestUrl: {
    sub: string; main: string; subH264: string; mainH264: string; master: string;
  };
}

/** What one agent has been asked to publish, and what it could not. */
export interface DesiredState {
  thingName: string;
  renditions: { cameraId: string; profile: 'sub' | 'main'; variant: 'source' | 'h264' }[];
  declined?: { cameraId: string; profile: 'sub' | 'main' }[];
  maxConcurrentTranscodes?: number;
}

export interface WatchResponse {
  keepaliveInSeconds: number;
  desired: DesiredState[];
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
    /** An exact camera, for showing one on its own. */
    cameraId?: string;
    q?: string; status?: string; cursor?: string; limit?: number;
  }) =>
    get<{ total: number; cursor?: string; cameras: Camera[] }>('/api/admin/cameras', p)
      .then((r): Page<Camera> => ({ total: r.total, cursor: r.cursor, items: r.cameras })),

  users: (p: { q?: string; cursor?: string; limit?: number } = {}) =>
    get<{ total: number; cursor?: string; users: User[] }>('/api/admin/users', p)
      .then((r): Page<User> => ({ total: r.total, cursor: r.cursor, items: r.users })),

  updateUser: (username: string, body: { role?: Role; premises?: string[]; enabled?: boolean }) =>
    patch<{ ok: true }>(`/api/admin/users/${encodeURIComponent(username)}`, body),

  createUser: (body: { email: string; role: Role; tenantId?: string; premises?: string }) =>
    post<{ username: string }>('/api/admin/users', body),

  deleteUser: (username: string) =>
    del<{ ok: true }>(`/api/admin/users/${encodeURIComponent(username)}`),

  createPremises: (body: { displayName: string; address?: string; tenantId?: string }) =>
    post<Premises>('/api/admin/premises', body),

  deletePremises: (premisesId: string) =>
    del<{ ok: true }>(`/api/admin/premises/${encodeURIComponent(premisesId)}`),

  createAgent: (body: { displayName: string; premisesId: string; tenantId?: string }) =>
    post<{ thingName: string }>('/api/admin/agents', body),

  deleteAgent: (thingName: string) =>
    del<{ ok: true }>(`/api/admin/agents/${encodeURIComponent(thingName)}`),

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

  /**
   * The manifests for the cameras named, and nothing else.
   *
   * Deliberately not "every camera at this site": ten thousand of them
   * serialise to more than a Lambda may return, and the grid only ever shows
   * a screenful.
   */
  streams: (p: { tenantId?: string; premisesId: string; cameraIds: string[] }) =>
    get<{ tenantId: string; cameras: Stream[] }>('/api/streams', {
      tenantId: p.tenantId, premisesId: p.premisesId, cameraIds: p.cameraIds.join(','),
    }).then((r) => r.cameras),

  /**
   * Declares what this viewer currently has on screen.
   *
   * This is what actually starts and stops streams, so it is a statement of
   * demand rather than a subscription: stop posting it and the agent stops
   * publishing within a minute.
   */
  watch: (body: {
    sessionId: string;
    premisesId: string;
    visible: string[];
    main?: { thingName: string; cameraId: string };
    codecs: string[];
    transcode: string[];
  }) => post<WatchResponse>('/api/watch', body),
};
