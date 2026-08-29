/**
 * Seeds a site to the scale this system is sold at, so the console and its
 * endpoints can be measured against it rather than against three cameras.
 *
 * Writes only camera registrations and the agents to hold them. It does not
 * fabricate LIVECAMERA records: those are written by an agent reporting, and
 * inventing them would make the read path look like it was serving streams
 * that do not exist.
 *
 * Lives under infra/ because it uses that package's AWS SDK. Run from there:
 *
 *   node scripts/seed-scale.mjs <tenantId> <premisesId> <cameras> [agents]
 *   node scripts/seed-scale.mjs --clean <tenantId> <premisesId>
 *
 * Seeded rows are marked `approvedBy: "seed"` and that is what --clean
 * removes, so it cannot delete a camera a person actually approved.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, BatchWriteCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.REGISTRY_TABLE ?? 'camstream-registry';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SEED_MARK = 'seed';
const NAMES = ['Roof Access', 'Perimeter', 'Reception', 'Car Park', 'Loading Bay',
  'Corridor', 'Stairwell', 'Server Room', 'Gate', 'Yard'];

const sitePk = (tenantId, premisesId) => `TENANT#${tenantId}#PREMISES#${premisesId}`;

/** DynamoDB takes 25 items a batch and returns whatever it could not write. */
async function writeAll(items) {
  for (let i = 0; i < items.length; i += 25) {
    let batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; batch.length && attempt < 8; attempt += 1) {
      const result = await ddb.send(new BatchWriteCommand({
        RequestItems: { [TABLE]: batch },
      }));
      batch = result.UnprocessedItems?.[TABLE] ?? [];
      if (batch.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
    if (i % 1000 === 0) process.stderr.write(`\r  ${i}/${items.length}`);
  }
  process.stderr.write(`\r  ${items.length}/${items.length}\n`);
}

async function seed(tenantId, premisesId, cameraCount, agentCount) {
  const pk = sitePk(tenantId, premisesId);

  const agents = Array.from({ length: agentCount }, (_, i) => {
    const thingName = `${tenantId}--${premisesId}--edge-${String(i + 1).padStart(3, '0')}`;
    return {
      pk, sk: `DEVICE#${thingName}`,
      thingName, premisesId, siteName: `Edge ${i + 1}`,
      connected: false, cameraCount: 0, maxConcurrentTranscodes: 1,
      approvedBy: SEED_MARK,
    };
  });

  const cameras = Array.from({ length: cameraCount }, (_, i) => {
    const n = i + 1;
    const identity = `mac-${String(n).padStart(12, '0')}`;
    // Spread across agents the way a real site would be, so per-agent counts
    // and the 128 ceiling are exercised rather than assumed.
    const agent = agents[i % agents.length];
    return {
      pk, sk: `CAMERA#${identity}`,
      identity,
      cameraId: `cam-${String(n).padStart(5, '0')}`,
      displayName: `${NAMES[i % NAMES.length]} ${String(n).padStart(5, '0')}`,
      assignedTo: agent.thingName,
      approvedAt: 1787900000 + n,
      approvedBy: SEED_MARK,
    };
  });

  console.error(`Agents (${agents.length}):`);
  await writeAll(agents);
  console.error(`Cameras (${cameras.length}):`);
  await writeAll(cameras);
}

/** Reads every seeded row at a site, then deletes it. */
async function clean(tenantId, premisesId) {
  const pk = sitePk(tenantId, premisesId);
  const doomed = [];
  for (const prefix of ['CAMERA#', 'DEVICE#', 'LIVECAMERA#']) {
    let start;
    do {
      const page = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': pk, ':s': prefix },
        ExclusiveStartKey: start,
      }));
      for (const item of page.Items ?? []) {
        // Only what this script wrote. A camera somebody actually approved
        // must survive a cleanup of a load test.
        if (item.approvedBy === SEED_MARK) doomed.push({ pk: item.pk, sk: item.sk });
      }
      start = page.LastEvaluatedKey;
    } while (start);
  }

  console.error(`Deleting ${doomed.length} seeded rows`);
  for (let i = 0; i < doomed.length; i += 25) {
    let batch = doomed.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; batch.length && attempt < 8; attempt += 1) {
      const result = await ddb.send(new BatchWriteCommand({
        RequestItems: { [TABLE]: batch },
      }));
      batch = result.UnprocessedItems?.[TABLE] ?? [];
      if (batch.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
    if (i % 1000 === 0) process.stderr.write(`\r  ${i}/${doomed.length}`);
  }
  process.stderr.write(`\r  ${doomed.length}/${doomed.length}\n`);
}

const [a, b, c, d] = process.argv.slice(2);
if (a === '--clean') {
  await clean(b, c);
} else if (a && b && c) {
  await seed(a, b, Number(c), Number(d ?? 16));
} else {
  console.error('usage: seed-scale.mjs <tenant> <premises> <cameras> [agents]');
  console.error('       seed-scale.mjs --clean <tenant> <premises>');
  process.exit(2);
}
