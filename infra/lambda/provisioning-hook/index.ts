import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseThingName } from '../shared/tenant';

const TABLE = process.env.REGISTRY_TABLE!;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Pre-provisioning hook for AWS IoT fleet provisioning by claim.
 *
 * The claim certificate is shared by every installer download, so on its own it
 * must be worth nothing. This is what makes that true: provisioning is refused
 * unless the request also carries an enrollment token that an administrator
 * minted for one specific agent, and the token is consumed here so a captured
 * installer cannot enrol a second device.
 *
 * Returning allowProvisioning: false — or throwing — denies the registration.
 */
interface HookEvent {
  claimCertificateId?: string;
  certificateId?: string;
  parameters?: Record<string, string>;
}

interface HookResult {
  allowProvisioning: boolean;
  parameterOverrides?: Record<string, string>;
}

export async function handler(event: HookEvent): Promise<HookResult> {
  const parameters = event.parameters ?? {};
  const token = parameters.EnrollmentToken;
  const thingName = parameters.ThingName;

  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    console.warn('provisioning refused: malformed enrollment token');
    return { allowProvisioning: false };
  }
  // The same validator the rest of the system uses. The loose regex here
  // would have registered a four-part thing name that the device lambda then
  // refuses forever, leaving an agent that can connect and never be served.
  const identity = thingName ? parseThingName(thingName) : null;
  if (!identity) {
    console.warn(`provisioning refused: bad thing name ${thingName}`);
    return { allowProvisioning: false };
  }
  const { tenantId, premisesId } = identity;

  const now = Math.floor(Date.now() / 1000);
  try {
    // Conditional update is the whole mechanism: it consumes the token and
    // refuses a second use atomically, so two devices racing the same
    // installer cannot both succeed.
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `TENANT#${tenantId}`, sk: `ENROLLMENT#${token}` },
        UpdateExpression: 'SET usedAt = :now, usedBy = :thing',
        ConditionExpression:
          'attribute_exists(sk) AND attribute_not_exists(usedAt) AND expiresAt > :now AND thingName = :thing',
        ExpressionAttributeValues: { ':now': now, ':thing': thingName },
        ReturnValues: 'ALL_NEW',
      }),
    );

    console.log(`provisioning ${thingName} (token issued by ${result.Attributes?.issuedBy ?? 'unknown'})`);
    return {
      allowProvisioning: true,
      // Echoed back so the template cannot be tricked by a client that sent
      // different values than the ones the token was minted for.
      parameterOverrides: { ThingName: thingName, TenantId: tenantId, PremisesId: premisesId },
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : String(err);
    if (name === 'ConditionalCheckFailedException') {
      // Already used, expired, unknown, or minted for a different agent — all
      // indistinguishable to the caller on purpose.
      console.warn(`provisioning refused for ${thingName}: token not valid`);
      return { allowProvisioning: false };
    }
    console.error('provisioning hook failed', err);
    return { allowProvisioning: false };
  }
}
