/**
 * Registry key layout.
 *
 *   TENANT#<t>  PREMISES#<premisesId>           a physical site
 *   TENANT#<t>  ENROLLMENT#<token>              one-time agent enrollment token
 *   TENANT#<t>  DEVICE#<thingName>              an enrolled agent
 *   TENANT#<t>  LIVECAMERA#<thing>#<cameraId>   a camera an agent can publish
 *   TENANT#<t>  DISCOVERED#<identity>           a physical camera, as seen by any agent
 *   TENANT#<t>  CAMERA#<identity>               a camera an administrator approved
 *   TENANT#<t>  DEMAND#<sessionId>              what one viewer currently wants
 *   TENANT#<t>  CREDENTIAL#<thingName>#<scope>  ciphertext only this agent can open
 *   USER#<sub>  SESSION                         the account's single live session
 *
 * Discovered cameras are keyed by the camera's own identity rather than by the
 * agent that found it. A premises large enough to need several agents will have
 * overlapping scan ranges, and the same camera seen twice must merge into one
 * record — otherwise it is approved twice, published twice, and billed twice.
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
};

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
