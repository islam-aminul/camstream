import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isValidId } from '../shared/tenant';
import { fail, json } from '../shared/http';

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
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const tenantId = event.requestContext.authorizer?.jwt?.claims?.['custom:tenantId'];
  if (!isValidId(tenantId)) {
    return fail(403, 'Account is not associated with a valid tenant');
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':prefix': 'CAMERA#' },
    }),
  );

  const now = Math.floor(Date.now() / 1000);
  const cameras = (result.Items ?? []).map((item) => {
    const record = item as CameraRecord;
    return {
      thingName: record.thingName,
      cameraId: record.cameraId,
      displayName: record.displayName ?? record.cameraId,
      resolution: record.width && record.height ? `${record.width}x${record.height}` : undefined,
      lastSeen: record.lastSeen,
      // A camera is live only if its agent has checked in recently; the TTL
      // sweep is too coarse to drive the UI on its own.
      online: typeof record.lastSeen === 'number' && now - record.lastSeen < 90,
      // Every URL is returned, but a rendition only exists in S3 while some
      // viewer has asked for it via /api/watch. The player picks `source` when
      // it can decode sourceCodec and `h264` otherwise.
      profiles: record.profiles ?? ['sub'],
      sourceCodec: record.sourceCodec ?? 'h264',
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
