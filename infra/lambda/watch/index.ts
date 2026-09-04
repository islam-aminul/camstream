import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, parseThingName, premisesScope, withinScope } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { identify, targetTenant } from '../shared/roles';
import { readSession, sessionSuperseded } from '../shared/session';
import { canDecode } from '../shared/playability';
import { DEFAULT_MAX_TRANSCODES, key, queryAllPages } from '../shared/registry';
import { emit, METRICS } from '../shared/metrics';

const TABLE = process.env.REGISTRY_TABLE!;
const IOT_ENDPOINT = process.env.IOT_DATA_ENDPOINT!;

/**
 * How long one keepalive keeps a rendition alive. The client re-posts well
 * inside this, so closing a tab stops the stream within a minute.
 */
const DEMAND_TTL_SECONDS = 60;

/**
 * How long an unchanged desired state may go unrepeated.
 *
 * Publishing only on change is what makes the fan-out affordable, but silence
 * is also how an agent decides everyone has left: it stops every rendition
 * once no instruction has arrived for `idleShutdownSeconds`. So this is not
 * merely a bound on how stale a dropped message may leave someone - it is the
 * heartbeat the agent is listening for, and it has to beat faster than that
 * window or a working stream stops itself mid-view. It did: at 300 against a
 * 30-second window every stream died half a minute in and flickered back once
 * every five minutes, which is indistinguishable from a stream that never
 * worked.
 *
 * The expensive thing was never the cadence, it was multiplying it by viewers.
 * This resends per agent that has demand, whether one person is watching or
 * fifty, so the fan-out stays flat. `watch-cadence.test.ts` holds the
 * relationship to the agent's window.
 */
const WATCH_RESEND_SECONDS = 45;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iot = new IoTDataPlaneClient({ endpoint: `https://${IOT_ENDPOINT}` });

/** The most cameras one viewer can hold open at once. */
export const MAX_VISIBLE = 64;

interface DemandRecord {
  sk: string;
  sessionId: string;
  /**
   * The cameras this viewer is actually showing, as "thingName/cameraId".
   *
   * Not "the grid is open": a site with a thousand cameras cannot publish a
   * thousand streams because somebody opened a page. Each one costs an ffmpeg
   * process at the edge and S3 requests per segment, so demand follows what is
   * on screen — a screenful, not an estate.
   */
  visible?: string[];
  mainThingName?: string;
  mainCameraId?: string;
  /** Codecs this viewer's browser can actually decode. */
  codecs?: string[];
  /**
   * When each requested transcode was first asked for.
   *
   * Slots go to the earliest request, which is what stops a later one from
   * evicting a stream somebody is already watching. Keyed by cameraId and
   * carried across keepalives, so a viewer's place in the queue survives.
   */
  transcodeSince?: Record<string, number>;
  /**
   * Cameras this viewer has explicitly asked the agent to transcode.
   *
   * Transcoding costs CPU at the edge and money, so it is never inferred from
   * a browser's limitations — a viewer who cannot decode a camera is shown the
   * choice and makes it.
   */
  transcode?: string[];
  /** Premises this viewer may drive. Empty means the whole tenant. */
  scope?: string[];
  expiresAt: number;
}

interface DeviceRecord {
  thingName: string;
  maxConcurrentTranscodes?: number;
  /** Digest of the last desired state actually published to this agent. */
  watchDigest?: string;
  /** When an unchanged state should be repeated anyway. */
  watchResendAfter?: number;
}

interface CameraRecord {
  thingName: string;
  cameraId: string;
  /** What the camera emits natively, reported by the agent. */
  sourceCodec?: string;
  /** Its profile, which decides playability independently of the codec name. */
  sourceCodecProfile?: string;
}

type Variant = 'source' | 'h264';

/** What a single agent should be publishing right now. */
interface DesiredState {
  thingName: string;
  renditions: { cameraId: string; profile: 'sub' | 'main'; variant: Variant }[];
  /**
   * Transcodes this agent was asked for and has no slot to run.
   *
   * Returned to the viewer so the reason is visible. Without it a capped
   * transcode is indistinguishable from a broken one: the rendition simply
   * never appears, and the player waits out its retries and reports the camera
   * as not being published.
   */
  declined?: { cameraId: string; profile: 'sub' | 'main' }[];
  /** The cap that did the declining, so the message can say what it is. */
  maxConcurrentTranscodes?: number;
}

/**
 * What this viewer should be served for a camera, or null to publish nothing.
 *
 * A viewer who cannot decode the source and has not asked for a transcode
 * contributes no demand: publishing the source would produce bytes they cannot
 * play, and transcoding without being asked would spend edge CPU and money on
 * their behalf.
 */
function variantFor(
  source: { codec?: string; profile?: string } | undefined,
  viewerCodecs: string[],
  transcodeRequested: boolean,
): Variant | null {
  if (canDecode(source?.codec, source?.profile, viewerCodecs)) {
    return 'source';
  }
  return transcodeRequested ? 'h264' : null;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const userSub = claims.sub;

  if (typeof userSub !== 'string') {
    return fail(403, 'Token carries no subject');
  }

  let body: {
    sessionId?: unknown;
    tenantId?: unknown;
    premisesId?: unknown;
    visible?: unknown;
    main?: unknown;
    codecs?: unknown;
    transcode?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return fail(400, 'Body must be JSON');
  }

  // Watching is gated on holding the tenant's single active session, so a
  // displaced tab stops driving agents immediately rather than at cookie expiry.
  if (typeof body.sessionId !== 'string') {
    return fail(400, 'Body must include sessionId');
  }
  // A viewer watches one site at a time — that is a product decision, and it is
  // what makes this call read one partition instead of the whole customer.
  // Resolving what an agent should publish needs every demand that mentions it;
  // partitioned by tenant that meant reading the tenant, some 11,500 items a
  // call at the size this is sold for, against a per-partition ceiling of about
  // 3,000 reads a second.
  if (!isValidId(body.premisesId)) {
    return fail(400, 'Body must include the premisesId being watched');
  }
  const premisesId = body.premisesId;

  // Whose cameras these are. The platform operator selects a customer in the
  // console, and reading their own tenant instead wrote the demand into an
  // empty partition and resolved a desired state from nothing: the agent was
  // never asked to publish, and every tile sat waiting for an acknowledgement
  // that was being filed under the wrong customer.
  const caller = identify(event);
  const tenantId = caller ? targetTenant(caller, body.tenantId) : null;
  if (!tenantId) {
    return fail(403, 'Not permitted to act on that tenant');
  }
  if (!withinScope(`${tenantId}--${premisesId}--x`, premisesScope(claims as Record<string, unknown>))) {
    return fail(403, 'That premises is not within your permitted sites');
  }
  const sitePk = key.site(tenantId, premisesId);
  const current = await readSession(ddb, TABLE, userSub);
  if (!current || current.sessionId !== body.sessionId
      || await sessionSuperseded(ddb, TABLE, userSub, claims as Record<string, unknown>)) {
    return fail(409, 'Session superseded by a newer sign-in');
  }

  // Capped rather than rejected: a client asking for more than it can show is
  // a client bug, and cutting it to a screenful is the safe reading.
  const visible = Array.isArray(body.visible)
    ? body.visible
        .filter((v: unknown): v is string => typeof v === 'string' && v.length <= 160 && v.includes('/'))
        .slice(0, MAX_VISIBLE)
    : [];

  // Bounds which agents this viewer can cause to start publishing. Without it
  // a restricted viewer drives — and bills — cameras at sites they cannot see.
  const scope = premisesScope(claims as Record<string, unknown>);

  // Declared by the player from MediaSource.isTypeSupported. Absent means we
  // assume the conservative floor and transcode anything exotic.
  const codecs = Array.isArray(body.codecs)
    ? body.codecs.filter((c: unknown): c is string => typeof c === 'string' && /^[a-z0-9]{1,12}$/i.test(c)).slice(0, 8)
    : [];
  // Keyed "thingName/cameraId", like `visible`. Keyed by cameraId alone, a
  // viewer asking to transcode their own cam-01 started an encode on every
  // agent in the tenant that happened to have a camera of that name — burning
  // a scarce slot, and the operator's CPU, at a site nobody had asked about.
  // Bare ids are still accepted and scoped to what the viewer can see, so an
  // older player keeps working.
  const transcode = Array.isArray(body.transcode)
    ? body.transcode
        .filter((c: unknown): c is string => typeof c === 'string' && c.length <= 160)
        .flatMap((entry: string) => {
          if (entry.includes('/')) {
            const slash = entry.indexOf('/');
            return parseThingName(entry.slice(0, slash)) && isValidId(entry.slice(slash + 1))
              ? [entry] : [];
          }
          return isValidId(entry) ? visible.map((v) => `${v.slice(0, v.indexOf('/'))}/${entry}`) : [];
        })
        .slice(0, 32)
    : [];

  // At most one full-resolution stream per viewer — this is the cap that keeps
  // main-stream bandwidth predictable.
  let mainThingName: string | undefined;
  let mainCameraId: string | undefined;
  if (body.main && typeof body.main === 'object') {
    const main = body.main as { thingName?: unknown; cameraId?: unknown };
    if (typeof main.thingName !== 'string' || typeof main.cameraId !== 'string') {
      return fail(400, 'main must be { thingName, cameraId }');
    }
    const parsed = parseThingName(main.thingName);
    if (!parsed || parsed.tenantId !== tenantId) {
      return fail(403, 'Device does not belong to this tenant');
    }
    if (!withinScope(main.thingName, scope)) {
      return fail(403, 'Device is not within your permitted premises');
    }
    if (!isValidId(main.cameraId)) {
      return fail(400, 'Invalid cameraId');
    }
    mainThingName = main.thingName;
    mainCameraId = main.cameraId;
  }

  const now = Math.floor(Date.now() / 1000);

  // Carried forward rather than restamped: a keepalive must not move a viewer
  // to the back of the queue, and a second request must not evict the first.
  const previous = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: sitePk, sk: key.demand(body.sessionId) },
  }));
  const wasRequestedAt = (previous.Item?.transcodeSince ?? {}) as Record<string, number>;
  const transcodeSince: Record<string, number> = {};
  for (const entry of transcode) {
    transcodeSince[entry] = wasRequestedAt[entry] ?? now;
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: sitePk,
        sk: key.demand(body.sessionId),
        sessionId: body.sessionId,
        visible,
        mainThingName,
        mainCameraId,
        codecs,
        transcode,
        transcodeSince,
        scope,
        expiresAt: now + DEMAND_TTL_SECONDS,
      },
    }),
  );

  const [demands, devices, cameras] = await Promise.all([
    queryPrefix<DemandRecord>(sitePk, 'DEMAND#'),
    queryPrefix<DeviceRecord>(sitePk, 'DEVICE#'),
    queryPrefix<CameraRecord>(sitePk, 'LIVECAMERA#'),
  ]);
  const digestOf = new Map(devices.map((d) => [d.thingName, d.watchDigest]));
  const resendDueAt = new Map(devices.map((d) => [d.thingName, d.watchResendAfter ?? 0]));

  const desired = resolveDesiredState(now, demands, devices, cameras);

  // Every agent is told its full desired state, including an empty one, so one
  // whose last viewer left learns to stop rather than time out — but only when
  // that state has actually changed.
  //
  // This used to publish to every agent in the tenant on every keepalive. The
  // player re-posts every 25 seconds per viewer, so the cost was
  // agents x viewers x 2.4 a minute, almost all of it telling agents nothing
  // had happened. A hundred-agent tenant with twenty viewers was some 4,800
  // messages a minute to say so.
  //
  // The digest lives on the device record, so a resend also happens whenever
  // the record is rewritten — and `resendAfter` bounds how long a dropped
  // message can leave an agent out of step.
  const publishes = desired.map(async (state) => {
    const digest = JSON.stringify(state.renditions);
    const previousDigest = digestOf.get(state.thingName);
    const dueAt = resendDueAt.get(state.thingName) ?? 0;
    if (digest === previousDigest && now < dueAt) {
      return;
    }
    await iot.send(
      new PublishCommand({
        topic: `camstream/${state.thingName}/watch`,
        qos: 1,
        payload: Buffer.from(JSON.stringify({ renditions: state.renditions, issuedAt: now })),
      }),
    );
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: sitePk, sk: key.device(state.thingName) },
      UpdateExpression: 'SET watchDigest = :digest, watchResendAfter = :due',
      ExpressionAttributeValues: { ':digest': digest, ':due': now + WATCH_RESEND_SECONDS },
    }));
  });
  await Promise.all(publishes);

  return json(200, {
    keepaliveInSeconds: Math.floor(DEMAND_TTL_SECONDS / 2),
    // Scoped like every other listing. The full set above drives the agents,
    // but returning it verbatim told a viewer restricted to one site the thing
    // name of every agent in the tenant — which encodes the premises — along
    // with the cameras other viewers had open there. A restriction that
    // blocked viewing would otherwise still leak the shape of the estate.
    desired: desired.filter((state) => withinScope(state.thingName, scope)),
  });
}

/**
 * Union of what every live session wants: the sub stream of each camera a
 * viewer currently has on screen, plus the main stream of the one they have
 * pinned open.
 *
 * TTL deletion is best-effort and can lag by minutes, so expired demand rows
 * are filtered by timestamp rather than trusted to be gone.
 */
export function resolveDesiredState(
  now: number,
  demands: DemandRecord[],
  devices: DeviceRecord[],
  cameras: CameraRecord[],
): DesiredState[] {
  const live = demands.filter((d) => d.expiresAt > now);

  const codecByCamera = new Map<string, { codec?: string; profile?: string }>();
  for (const camera of cameras) {
    codecByCamera.set(`${camera.thingName}/${camera.cameraId}`, {
      codec: camera.sourceCodec,
      profile: camera.sourceCodecProfile,
    });
  }

  // Keyed by camera+profile+variant: two viewers with different browsers can
  // legitimately require the same camera in two codecs at once.
  const byThing = new Map<string, Map<string, { cameraId: string; profile: 'sub' | 'main'; variant: Variant }>>();
  for (const device of devices) {
    byThing.set(device.thingName, new Map());
  }

  // The earliest moment anybody asked for each transcode, across all viewers.
  const requestedAt = new Map<string, number>();

  const want = (
    thingName: string,
    cameraId: string,
    profile: 'sub' | 'main',
    viewerCodecs: string[],
    transcodeRequested: string[],
  ) => {
    const bucket = byThing.get(thingName);
    if (!bucket) return;
    const variant = variantFor(
      codecByCamera.get(`${thingName}/${cameraId}`),
      viewerCodecs,
      transcodeRequested.includes(`${thingName}/${cameraId}`),
    );
    if (variant === null) {
      return;
    }
    bucket.set(`${cameraId}/${profile}/${variant}`, { cameraId, profile, variant });
  };

  for (const demand of live) {
    const viewerCodecs = demand.codecs ?? [];
    const transcodeRequested = demand.transcode ?? [];
    for (const [entry, at] of Object.entries(demand.transcodeSince ?? {})) {
      const existing = requestedAt.get(entry);
      if (existing === undefined || at < existing) {
        requestedAt.set(entry, at);
      }
    }
    for (const entry of demand.visible ?? []) {
      const slash = entry.indexOf('/');
      const thingName = entry.slice(0, slash);
      const cameraId = entry.slice(slash + 1);
      if (!withinScope(thingName, demand.scope ?? [])) {
        continue;
      }
      // Checked against the registry: a viewer must not be able to name a
      // camera into existence, only ask for one that is already assigned.
      if (!cameras.some((c) => c.thingName === thingName && c.cameraId === cameraId)) {
        continue;
      }
      want(thingName, cameraId, 'sub', viewerCodecs, transcodeRequested);
    }
    if (demand.mainThingName && demand.mainCameraId) {
      // The pinned camera gets both rungs: the sub it already had, plus main.
      // That pair is the ABR ladder, and the detail view is the only place a
      // stream is large enough to outrun a viewer's connection.
      want(demand.mainThingName, demand.mainCameraId, 'main', viewerCodecs, transcodeRequested);
      want(demand.mainThingName, demand.mainCameraId, 'sub', viewerCodecs, transcodeRequested);
    }
  }

  const capOf = new Map(devices.map((d) => [
    d.thingName,
    typeof d.maxConcurrentTranscodes === 'number' ? d.maxConcurrentTranscodes : DEFAULT_MAX_TRANSCODES,
  ]));

  return [...byThing.entries()].map(([thingName, renditions]) => {
    const sorted = [...renditions.values()].sort(
      (a, b) => a.cameraId.localeCompare(b.cameraId) || a.profile.localeCompare(b.profile) || a.variant.localeCompare(b.variant),
    );
    return applyTranscodeCap(
      thingName, sorted, capOf.get(thingName) ?? DEFAULT_MAX_TRANSCODES, requestedAt);
  });
}

/**
 * Holds an agent to the number of transcodes it is allowed to run.
 *
 * Enforced here as well as on the agent so a viewer learns immediately that no
 * slot is free. The agent enforces it too, since it owns the CPU and cannot
 * assume the control plane is reachable or truthful — this is the copy that
 * exists to produce a good message, not the one that protects the hardware.
 *
 * Stream copies are never capped and are kept whole: they cost almost nothing,
 * and letting an encode crowd one out would take down cameras that were
 * working to serve one that was not.
 */
function applyTranscodeCap(
  thingName: string,
  renditions: { cameraId: string; profile: 'sub' | 'main'; variant: Variant }[],
  cap: number,
  requestedAt: Map<string, number>,
): DesiredState {
  const kept: typeof renditions = [];
  const declined: { cameraId: string; profile: 'sub' | 'main' }[] = [];

  // Slots go to whoever asked first. Allocating them by name instead let a
  // later request evict a transcode somebody was already watching — and, with
  // two viewers, let one silently take the other's stream away. Ties fall back
  // to the name so the choice is at least stable between calls.
  const queuedAt = (r: { cameraId: string }) => requestedAt.get(`${thingName}/${r.cameraId}`) ?? Infinity;
  const contenders = renditions
    .filter((r) => r.variant === 'h264')
    .sort((a, b) => queuedAt(a) - queuedAt(b)
      || a.cameraId.localeCompare(b.cameraId)
      || a.profile.localeCompare(b.profile));
  const granted = new Set(contenders.slice(0, Math.max(0, cap))
    .map((r) => `${r.cameraId}/${r.profile}`));

  for (const rendition of renditions) {
    if (rendition.variant !== 'h264') {
      kept.push(rendition);
      continue;
    }
    if (granted.has(`${rendition.cameraId}/${rendition.profile}`)) {
      kept.push(rendition);
    } else {
      declined.push({ cameraId: rendition.cameraId, profile: rendition.profile });
    }
  }

  if (declined.length > 0) {
    // Somebody is looking at a tile that says the site is at capacity and will
    // not recover on its own. Counted fleet-wide: the question an alarm can
    // answer is "are viewers being refused", not which camera.
    emit(METRICS.TRANSCODES_DECLINED, declined.length);
    return { thingName, renditions: kept, declined, maxConcurrentTranscodes: cap };
  }
  return { thingName, renditions: kept };
}

function queryPrefix<T>(pk: string, prefix: string): Promise<T[]> {
  return queryAllPages<T>(
    (input) => ddb.send(new QueryCommand(input)), TABLE, pk, prefix);
}
