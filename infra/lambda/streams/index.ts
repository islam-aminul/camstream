import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { sessionSuperseded } from '../shared/session';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, parseThingName, premisesScope, withinScope } from '../shared/tenant';
import { identify, targetTenant } from '../shared/roles';
import { fail, json } from '../shared/http';
import { key, queryAllPages } from '../shared/registry';

const TABLE = process.env.REGISTRY_TABLE!;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface CameraRecord {
  sk: string;
  thingName: string;
  cameraId: string;
  displayName?: string;
  online?: boolean;
  lastSeen?: number;
  width?: number;
  height?: number;
  profiles?: string[];
  sourceCodec?: string;
  sourceCodecProfile?: string;
  ipAddress?: string;
  macAddress?: string;
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const caller = identify(event);
  if (!caller) {
    return fail(403, 'Account is not associated with a valid tenant');
  }
  // A superadmin selects a customer before a site, so this takes the same
  // optional tenantId the admin reads take. Without it the top level of the
  // rail can pick a customer whose cameras it then cannot show.
  const tenantId = targetTenant(caller, event.queryStringParameters?.tenantId);
  if (!tenantId) return fail(403, 'Not permitted to act on that tenant');
  const scope = premisesScope(claims as Record<string, unknown> | undefined);

  // Cameras are read for one site, not one customer. Ten thousand cameras
  // serialised at 810 bytes each is 7.7 MB, past the 6 MB a Lambda may return,
  // so the tenant-wide form of this endpoint stopped working before the
  // console could render it.
  const premisesId = event.queryStringParameters?.premisesId;
  if (!isValidId(premisesId)) {
    return fail(400, 'premisesId is required');
  }
  if (!withinScope(`${tenantId}--${premisesId}--x`, scope)) {
    return fail(403, 'That premises is not within your permitted sites');
  }
  const sitePk = key.site(tenantId, premisesId);

  if (await sessionSuperseded(ddb, TABLE, String(claims?.sub ?? ''), claims as Record<string, unknown>)) {
    return fail(409, 'Session superseded by a newer sign-in');
  }

  const [records, devices] = await Promise.all([
    queryAllPages<Record<string, unknown>>(
      (input) => ddb.send(new QueryCommand(input)), TABLE, sitePk, 'LIVECAMERA#'),
    // Paginated like the cameras beside it. A single Query stops at 1MB, and
    // a short device list does not error — it just leaves every camera whose
    // agent fell off the end reported as offline.
    queryAllPages<Record<string, unknown>>(
      (input) => ddb.send(new QueryCommand(input)), TABLE, sitePk, 'DEVICE#'),
  ]);

  // A camera is reachable exactly when the agent that publishes it is
  // connected. Reports are event-driven, so their timestamps go stale within
  // minutes of a quiet estate — judging liveness by them marked every camera
  // offline while its agent sat happily connected.
  const connected = new Map<string, boolean>(
    devices.map((device) => [String(device.thingName ?? ''), device.connected === true]),
  );
  const siteOf = new Map<string, string>(
    devices
      .filter((device) => typeof device.siteName === 'string')
      .map((device) => [String(device.thingName ?? ''), String(device.siteName)]),
  );

  // The console names what is on screen. Returning the whole site was what
  // made this endpoint outgrow a Lambda response; sixteen tiles is sixteen
  // entries, and the camera list itself comes from /api/admin/cameras.
  const wanted = (event.queryStringParameters?.cameraIds ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  const wantedSet = new Set(wanted);

  const cameras = records
    .filter((item: Record<string, unknown>) => {
      if (wantedSet.size === 0) return true;
      const record = item as unknown as CameraRecord;
      return wantedSet.has(record.cameraId)
        || wantedSet.has(`${record.thingName}/${record.cameraId}`);
    })
    // A restricted viewer must not learn which other sites exist, what their
    // agents are called, or what is watched there.
    .filter((item: Record<string, unknown>) =>
      withinScope(String((item as unknown as CameraRecord).thingName ?? ''), scope))
    .map((item: Record<string, unknown>) => {
    const record = item as unknown as CameraRecord;
    return {
      thingName: record.thingName,
      cameraId: record.cameraId,
      displayName: record.displayName ?? record.cameraId,
      resolution: record.width && record.height ? `${record.width}x${record.height}` : undefined,
      lastSeen: record.lastSeen,
      online: connected.get(record.thingName) === true,
      // Grouping and filtering keys. The thing name already encodes premises,
      // but parsing it in the client would tie the UI to that format.
      premisesId: parseThingName(String(record.thingName ?? ''))?.premisesId ?? null,
      ipAddress: record.ipAddress ?? null,
      macAddress: record.macAddress ?? null,
      siteName: siteOf.get(String(record.thingName ?? '')) ?? null,
      // Every URL is returned, but a rendition only exists in S3 while some
      // viewer has asked for it via /api/watch. The player picks `source` when
      // it can decode sourceCodec and `h264` otherwise.
      profiles: record.profiles ?? ['sub'],
      sourceCodec: record.sourceCodec ?? 'h264',
      // Sent alongside the codec because the client cannot decide playability
      // without it: High 10 is "h264" that nothing decodes.
      sourceCodecProfile: record.sourceCodecProfile ?? null,
      manifestUrl: {
        sub: `/live/${record.thingName}/${record.cameraId}/sub/index.m3u8`,
        main: `/live/${record.thingName}/${record.cameraId}/main/index.m3u8`,
        subH264: `/live/${record.thingName}/${record.cameraId}/sub-h264/index.m3u8`,
        mainH264: `/live/${record.thingName}/${record.cameraId}/main-h264/index.m3u8`,
        // Present only while the camera is publishing more than one rendition,
        // which is what the detail view causes.
        master: `/live/${record.thingName}/${record.cameraId}/master.m3u8`,
      },
    };
  });

  cameras.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return json(200, { tenantId, cameras });
}
