import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseThingName } from '../shared/tenant';
import { key } from '../shared/registry';

const TABLE = process.env.REGISTRY_TABLE!;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Turns AWS IoT connect/disconnect events into agent liveness.
 *
 * This replaces polling. A 30s heartbeat could only ever say "alive within the
 * last 30 seconds" and cost a request per agent per interval; a presence event
 * says exactly when the connection dropped, arrives immediately, and costs
 * nothing while an agent is simply connected.
 */
interface PresenceEvent {
  clientId?: string;
  eventType?: 'connected' | 'disconnected';
  timestamp?: number;
  disconnectReason?: string;
}

export async function handler(event: PresenceEvent): Promise<void> {
  // Agents connect with their thing name as the client id.
  const clientId = event.clientId ?? '';
  const identity = parseThingName(clientId);
  if (!identity) {
    // Other clients share this event stream; ignore anything not an agent.
    return;
  }

  const connected = event.eventType === 'connected';
  const at = Math.floor((event.timestamp ?? Date.now()) / 1000);

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      // The agent's own site, from the name it connected with. This wrote to
      // the customer partition until the registry was split, which left every
      // agent reading as offline in a console that looks at the site.
      Key: { pk: key.site(identity.tenantId, identity.premisesId), sk: key.device(clientId) },
      UpdateExpression:
        'SET connected = :connected, lastSeen = :at, lastPresenceAt = :at, disconnectReason = :reason',
      // Events can arrive out of order after a flapping connection; an older
      // event must not overwrite a newer state.
      ConditionExpression: 'attribute_not_exists(lastPresenceAt) OR lastPresenceAt <= :at',
      ExpressionAttributeValues: {
        ':connected': connected,
        ':at': at,
        ':reason': connected ? null : (event.disconnectReason ?? 'UNKNOWN'),
      },
    }),
  ).catch((err) => {
    if (err?.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw err;
  });
}
