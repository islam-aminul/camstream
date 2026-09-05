import { get, post, patch, del, download } from './client';

export type Role = 'superadmin' | 'admin' | 'operator' | 'viewer';

/** One address subscribed to the platform alarm topic. */
export interface AlertRecipient {
  endpoint: string;
  protocol: string;
  /**
   * False until the address clicks the link AWS sends. An unconfirmed
   * subscription exists and receives nothing, which is the distinction the
   * page has to make loudly.
   */
  confirmed: boolean;
  arn: string;
}

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
  /** Epoch seconds of the agent's last report, or absent if it never has. */
  lastSeen?: number | null;
  /**
   * How far this machine's clock is from the control plane's, in seconds,
   * positive when the agent is behind. Measured server-side from the agent's
   * own stamp on its last report.
   *
   * Null means it has never said — an older build, or one that has never
   * reported. That is not the same as zero, and the console must not show it
   * as though the clock were known to be right.
   */
  clockSkewSeconds?: number | null;
  health?: {
    at: number | null;
    healthy: boolean;
    failingTasks: string[];
    publishing: number;
    uptimeSeconds?: number | null;
    agentVersion?: string | null;
    /**
     * Which resource is running out on the machine, decided by the agent — the
     * only thing that can see it. 'none' when it has headroom.
     */
    constraint?: 'none' | 'cpu' | 'memory' | 'disk' | 'uplink';
    /** What to do about it, in a sentence, or null when there is nothing to do. */
    constraintMessage?: string | null;
    resources?: {
      cpuLoad: number | null;
      memoryUsedFraction: number | null;
      memoryFreeBytes: number | null;
      diskFreeBytes: number | null;
      uploadBytesPerSecond: number | null;
      uploadMillisPerSegment: number | null;
    };
  } | null;
}

export interface Camera {
  identity: string;
  cameraId: string;
  displayName: string;
  assignedTo: string;
  /** Epoch seconds when this camera was put into service. */
  approvedAt?: number | null;
  approvedBy?: string | null;
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


/** A camera an agent has seen on the network but nobody has approved yet. */
export interface Discovered {
  identity: string;
  identityStable: boolean;
  macAddress?: string;
  /** How the identity was derived, so it is visible rather than magic. */
  identifiedBy: 'mac' | 'serial' | 'address';
  manufacturer?: string;
  model?: string;
  lastSeen?: number;
  /** Every agent that can currently reach it, and on what address. */
  reachableBy: {
    thingName: string;
    premisesId?: string;
    ipAddress?: string;
    authState?: string;
    lastSeen?: number;
    profiles: { token: string; name?: string; width?: number; height?: number; codec?: string }[];
  }[];
  /** Set once approved, so the list can show what is already in the estate. */
  approved: { cameraId: string; displayName: string; assignedTo: string } | null;
}

export type Platform = 'linux' | 'windows';

/**
 * A credential as the console may see it: which slot, whose account, when set.
 * Never the password — no route returns one.
 */
export interface StoredCredential {
  scope: string;
  username: string | null;
  storedAt: number | null;
  storedBy: string | null;
  siteWide: boolean;
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

  /**
   * Starts or refreshes the session, and with it the cookies that authorise
   * video. Naming the site being watched narrows those cookies to it.
   */
  session: (sessionId?: string, premisesId?: string, tenantId?: string) =>
    post<SessionInfo>('/api/session', {
      ...(sessionId ? { sessionId } : {}),
      ...(premisesId ? { premisesId } : {}),
      ...(tenantId ? { tenantId } : {}),
    }),

  customers: () =>
    get<{ customers: Customer[] }>('/api/admin/customers').then((r) => r.customers),

  createCustomer: (displayName: string) =>
    post<Customer>('/api/admin/customers', { displayName }),

  premises: (tenantId?: string) =>
    get<{ premises: Premises[] }>('/api/admin/premises', { tenantId }).then((r) => r.premises),

  /**
   * Carries `currentVersion` alongside the page: the build an Update would
   * install. It belongs to the control plane rather than to any agent, so it
   * arrives once per response, and it is what lets the console say whether an
   * agent is already up to date instead of offering an Update that does nothing.
   */
  agents: (p: { tenantId?: string; premisesId: string; q?: string; cursor?: string; limit?: number }) =>
    get<{ total: number; cursor?: string; agents: Agent[]; currentVersion?: string }>(
      '/api/admin/agents', p,
    ).then((r): Page<Agent> & { currentVersion?: string } => ({
      total: r.total, cursor: r.cursor, items: r.agents, currentVersion: r.currentVersion,
    })),

  cameras: (p: {
    tenantId?: string; premisesId: string; agentId?: string;
    /** An exact camera, for showing one on its own. */
    cameraId?: string;
    q?: string; status?: string; cursor?: string; limit?: number;
  }) =>
    get<{ total: number; cursor?: string; cameras: Camera[] }>('/api/admin/cameras', p)
      .then((r): Page<Camera> => ({ total: r.total, cursor: r.cursor, items: r.cameras })),

  /** Who is emailed when the control plane raises an alarm. Superadmin only. */
  alertRecipients: () =>
    get<{ topicArn: string; recipients: AlertRecipient[] }>('/api/admin/alerts'),

  /**
   * Invites an address. AWS emails it a confirmation link and delivers nothing
   * until that is clicked, which is why this reports "pending" rather than
   * "subscribed".
   */
  addAlertRecipient: (email: string) =>
    post<{ pending: string }>('/api/admin/alerts', { email }),

  removeAlertRecipient: (arn: string) =>
    del<{ removed: string }>('/api/admin/alerts', { arn }),

  /**
   * Moves cameras between the agents of one premises, all or nothing.
   *
   * A move is one entry and a swap is two. Two requests would not do: the
   * first would succeed, the second could be refused, and both cameras would
   * end up on one agent with nobody having asked for that.
   */
  moveCameras: (body: {
    moves: { identity: string; assignedTo: string }[];
    premisesId: string; tenantId?: string;
  }) => post<{ moved: number; agentsNotified: string[] }>('/api/admin/cameras/move', body),

  /**
   * Renames one camera. The only thing about a camera an operator chooses,
   * and until this existed it could only be chosen at approval time.
   */
  renameCamera: (identity: string, body: { displayName: string; premisesId: string; tenantId?: string }) =>
    patch<{ identity: string; displayName: string }>(
      `/api/admin/cameras/${encodeURIComponent(identity)}`, body),

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

  /**
   * Enrols an agent. The name is `siteName` because the route derives the
   * device id from it, and the id becomes part of the IoT thing name.
   */
  createAgent: (body: { siteName: string; premisesId: string; tenantId?: string }) =>
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
    /** The customer being watched; the server ignores it unless you may cross. */
    tenantId?: string;
    premisesId: string;
    visible: string[];
    main?: { thingName: string; cameraId: string };
    codecs: string[];
    transcode: string[];
  }) => post<WatchResponse>('/api/watch', body),

  /**
   * Cameras the agents can see but nobody has approved.
   *
   * Not paged: this is a working queue, emptied as an installer walks a site,
   * and it is bounded by what is physically on one network.
   */
  discovered: (p: { tenantId?: string; premisesId: string }) =>
    get<{ cameras: Discovered[] }>('/api/admin/discovered', p).then((r) => r.cameras),

  /** Brings a discovered camera into the estate, on one named agent. */
  approveCamera: (body: {
    identity: string;
    assignedTo: string;
    cameraId?: string;
    displayName?: string;
    subProfileToken?: string;
    mainProfileToken?: string;
    sourceCodec?: string;
  }) => post<{ approved: string }>('/api/admin/cameras', body),

  removeCamera: (p: { identity: string; premisesId: string; tenantId?: string }) =>
    del<{ ok: true }>(`/api/admin/cameras/${encodeURIComponent(p.identity)}`, {
      premisesId: p.premisesId, tenantId: p.tenantId,
    }),

  /**
   * Tells an agent to install the current build and restart into it.
   *
   * The agent decides whether to obey: it refuses a version it is already
   * running. Sending is not the same as being obeyed, which is the right way
   * round for something that replaces a program.
   */
  upgradeAgent: (thingName: string, platform: Platform) =>
    post<{ requested: string; version: string }>(
      `/api/admin/agents/${encodeURIComponent(thingName)}/update`, { platform }),

  /**
   * Sets how many cameras one agent may convert at once.
   *
   * A ceiling on intent, not on capability: the agent applies its own resource
   * limit underneath this, so asking for more than the machine can bear gets
   * what the machine can bear.
   */
  setTranscodeCap: (thingName: string, maxConcurrentTranscodes: number) =>
    patch<{ thingName: string; maxConcurrentTranscodes: number }>(
      `/api/admin/agents/${encodeURIComponent(thingName)}`, { maxConcurrentTranscodes }),

  /** Asks one agent to sweep its network now, rather than waiting for its cycle. */
  scan: (thingName: string) =>
    post<{ requested: string }>('/api/admin/scan', { thingName }),

  /**
   * Hands the control plane ciphertext it cannot read.
   *
   * The credential is sealed in the browser against the agent's own public key,
   * so the plaintext never reaches the network and no part of this system but
   * that agent can open it.
   */
  credentials: (thingName: string) =>
    get<{ credentials: StoredCredential[]; maxSiteCredentials: number }>(
      '/api/admin/credentials', { thingName }),

  storeCredential: (body: {
    thingName: string; scope: string; ciphertext: string; username: string;
  }) => post<{ stored: string }>('/api/admin/credentials', body),

  removeCredential: (thingName: string, scope: string) =>
    del<{ ok: true }>('/api/admin/credentials', { thingName, scope }),

  /**
   * Downloads an agent installer carrying a one-use enrolment token.
   *
   * A zip: the script, a launcher that does not need the execution policy
   * changed, and the note describing the runtime archives the operator has to
   * supply. Fetched rather than linked, because the route is authorised by a
   * header a plain link does not send — a link would save a 401 to disk.
   */
  installer: (thingName: string, platform: Platform) =>
    download(
      `/api/admin/agents/${encodeURIComponent(thingName)}/installer?platform=${platform}`,
      `camstream-agent-${thingName}-${platform}.zip`,
    ),
};
