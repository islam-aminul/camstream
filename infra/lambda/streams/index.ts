import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { sessionSuperseded } from '../shared/session';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId, parseThingName, premisesScope, withinScope } from '../shared/tenant';
import { fail, json } from '../shared/http';
import { queryAllPages } from '../shared/registry';

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
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const tenantId = claims?.['custom:tenantId'];
  if (!isValidId(tenantId)) {
    return fail(403, 'Account is not associated with a valid tenant');
  }
  const scope = premisesScope(claims as Record<string, unknown> | undefined);

  if (await sessionSuperseded(ddb, TABLE, String(claims?.sub ?? ''), claims as Record<string, unknown>)) {
    return fail(409, 'Session superseded by a newer sign-in');
  }

  const [records, devices] = await Promise.all([
    queryAllPages<Record<string, unknown>>(
      (input) => ddb.send(new QueryCommand(input)),
      TABLE, `TENANT#${tenantId}`, 'LIVECAMERA#'),
    ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':prefix': 'DEVICE#' },
    })),
  ]);

  // A camera is reachable exactly when the agent that publishes it is
  // connected. Reports are event-driven, so their timestamps go stale within
  // minutes of a quiet estate — judging liveness by them marked every camera
  // offline while its agent sat happily connected.
  const connected = new Map<string, boolean>(
    (devices.Items ?? []).map((device) => [String(device.thingName ?? ''), device.connected === true]),
  );
  const siteOf = new Map<string, string>(
    (devices.Items ?? [])
      .filter((device) => typeof device.siteName === 'string')
      .map((device) => [String(device.thingName ?? ''), String(device.siteName)]),
  );

  const cameras = records
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
