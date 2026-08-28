/**
 * Registry key layout.
 *
 *   REGISTRY                  CUSTOMER#<tenantId>              a customer
 *   TENANT#<t>                PREMISES#<premisesId>            a physical site
 *   TENANT#<t>                ENROLLMENT#<token>               one-time agent token
 *   TENANT#<t>                HEALTH#<thingName>               last heartbeat
 *   TENANT#<t>#PREMISES#<p>   DEVICE#<thingName>               an enrolled agent
 *   TENANT#<t>#PREMISES#<p>   CAMERA#<identity>                an approved camera
 *   TENANT#<t>#PREMISES#<p>   LIVECAMERA#<thing>#<cameraId>    a camera being published
 *   TENANT#<t>#PREMISES#<p>   DISCOVERED#<identity>            a camera any agent can see
 *   TENANT#<t>#PREMISES#<p>   CREDENTIAL#<thing>#<scope>       ciphertext for one agent
 *   TENANT#<t>#PREMISES#<p>   DEMAND#<sessionId>               what one viewer wants
 *   USER#<sub>                SESSION                          the single live session
 *
 * Premises is the partition for everything that scales with the estate, and
 * that is the whole point. A single partition key gets about 3,000 reads a
 * second regardless of what the table is provisioned for, and resolving what
 * an agent should publish means reading every demand that mentions it — which,
 * partitioned by tenant, meant reading the tenant. A hundred sites is a
 * hundred partitions and about a hundredth of the work per call.
 *
 * Three things stay at tenant level on purpose. Premises and enrollment tokens
 * are few and are read before a premises is known. Health is written by an IoT
 * topic rule with no Lambda in the path, and that rule builds its key in SQL —
 * it can cut the thing name at the first separator but not the second, because
 * IoT SQL has no indexof that takes an offset. A thousand agents heartbeating
 * once a minute is about seventeen writes a second, comfortably inside one
 * partition, so the cheap rule survives and the console fetches health only
 * for the agents on the page it is showing.
 *
 * Discovered cameras are keyed by the camera's own identity rather than by the
 * agent that found it. A premises large enough to need several agents will
 * have overlapping scan ranges, and the same camera seen twice must merge into
 * one record — otherwise it is approved twice, published twice, and billed
 * twice.
 */
export const key = {
  premises: (premisesId: string) => `PREMISES#${premisesId}`,
  enrollment: (token: string) => `ENROLLMENT#${token}`,
  device: (thingName: string) => `DEVICE#${thingName}`,
  /** A camera an agent is currently able to publish, as reported by it. */
  liveCamera: (thingName: string, cameraId: string) => `LIVECAMERA#${thingName}#${cameraId}`,
  discovered: (identity: string) => `DISCOVERED#${identity}`,
  camera: (identity: string) => `CAMERA#${identity}`,
  demand: (sessionId: string) => `DEMAND#${sessionId}`,
  credential: (thingName: string, scope: string) => `CREDENTIAL#${thingName}#${scope}`,
  tenant: (tenantId: string) => `TENANT#${tenantId}`,
  /**
   * The partition holding everything that scales with the estate.
   *
   * Every camera, agent, sighting, credential and viewer demand for one site
   * lives here, which is what keeps a watch call reading one premises rather
   * than one customer.
   */
  site: (tenantId: string, premisesId: string) => `TENANT#${tenantId}#PREMISES#${premisesId}`,
  /**
   * The customer itself, under a registry-wide partition.
   *
   * A tenant used to exist only as a prefix on other people's keys — writing
   * into `TENANT#acme` was what brought it into being, so a typo created a
   * customer nobody could find, and nothing could enumerate them. This record
   * makes a customer a thing that can be listed, named and refused.
   */
  customer: (tenantId: string) => `CUSTOMER#${tenantId}`,
};

/** Partition holding the customer list. One row per customer; there are few. */
export const REGISTRY_PK = 'REGISTRY';

export interface CustomerRecord {
  pk: string;
  sk: string;
  tenantId: string;
  displayName: string;
  createdAt: number;
  createdBy: string;
}

/** How one agent sees a camera. A camera may be reachable from several. */
export interface Sighting {
  ipAddress: string;
  authState: string;
  lastSeen: number;
  profiles: DiscoveredProfile[];
}

export interface DiscoveredProfile {
  token: string;
  name?: string;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface DiscoveredRecord {
  pk: string;
  sk: string;
  identity: string;
  identityStable: boolean;
  macAddress?: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  /** thingName -> how that agent sees it. */
  reachableBy: Record<string, Sighting>;
  lastSeen: number;
  expiresAt: number;
}

export interface PremisesRecord {
  pk: string;
  sk: string;
  premisesId: string;
  displayName: string;
  address?: string;
  createdAt: number;
  createdBy: string;
}

/**
 * A one-time token that lets one installer enrol exactly one agent.
 *
 * The claim certificate in an installer is shared by every download, so this is
 * the credential that actually authorises provisioning. Consumed atomically by
 * the pre-provisioning hook.
 */
export interface EnrollmentRecord {
  pk: string;
  sk: string;
  token: string;
  thingName: string;
  premisesId: string;
  issuedAt: number;
  issuedBy: string;
  expiresAt: number;
  usedAt?: number;
}

export interface CameraRecord {
  pk: string;
  sk: string;
  identity: string;
  /** URL-safe slug used in S3 keys and manifest paths. */
  cameraId: string;
  displayName: string;
  /**
   * The single agent responsible for publishing this camera. Ownership is
   * explicit because several agents may be able to reach it, and more than one
   * publishing the same camera would double both cost and confusion.
   */
  assignedTo: string;
  subProfileToken?: string;
  mainProfileToken?: string;
  sourceCodec?: string;
  approvedAt: number;
  approvedBy: string;
}

/** Slug derived from an identity, safe for S3 keys and CloudFront paths. */
export function slugFor(identity: string): string {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Must satisfy the same rule as configured camera ids: 3-32 chars, no '--'.
  const collapsed = slug.replace(/-{2,}/g, '-');
  return collapsed.slice(0, 32).padEnd(3, '0');
}

/**
 * Transcodes one agent will run at once, until an administrator says
 * otherwise.
 *
 * One, because that is the safe assumption for hardware nobody has measured:
 * an encode costs roughly a core per 1080p stream, and an edge box is usually
 * a small one with other work to do. Raising it is a decision about a specific
 * machine, so it belongs to whoever knows that machine.
 */
export const DEFAULT_MAX_TRANSCODES = 1;

/**
 * One page of items, and where to resume.
 *
 * The cursor is DynamoDB's own LastEvaluatedKey, base64-encoded so a caller
 * cannot read meaning into it or hand back something we would then trust as a
 * key. It is opaque on purpose: the shape of a page boundary is ours to change.
 */
export interface Page<T> {
  items: T[];
  cursor?: string;
}

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;
}

/**
 * Decodes a cursor, or returns undefined for anything that is not one.
 *
 * A malformed cursor starts the listing again rather than failing: a stale
 * bookmark should show the first page, not an error page.
 */
export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every item under one partition and sort-key prefix.
 *
 * DynamoDB caps a Query response at 1MB and hands back a cursor for the rest.
 * A single Query therefore reads about three thousand camera records and then
 * silently stops — the caller sees a short list, not an error, and an estate
 * larger than that loses cameras from the console with nothing to indicate it.
 * Following the cursor is the difference between "works in the demo" and
 * "works at the size this is sold for".
 */
export async function queryAllPages<T>(
  send: (input: {
    TableName: string;
    KeyConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
    ExclusiveStartKey?: Record<string, unknown>;
  }) => Promise<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>,
  table: string,
  pk: string,
  prefix: string,
): Promise<T[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await send({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
      ExclusiveStartKey: cursor,
    });
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items as T[];
}
