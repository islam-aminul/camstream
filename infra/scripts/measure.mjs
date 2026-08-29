/**
 * Measures the endpoints the console calls, against a site seeded to scale.
 *
 * Reports latency and — the number that actually bit this system once before —
 * response size, because a Lambda may return six megabytes and an endpoint
 * that returns a whole site outgrows that somewhere around seven thousand
 * cameras.
 *
 *   CS_TOKEN=... node scripts/measure.mjs <tenant> <premises>
 */
const API = process.env.CS_API ?? 'https://camstream.online';
const TOKEN = process.env.CS_TOKEN;
const [tenantId, premisesId] = process.argv.slice(2);

if (!TOKEN || !tenantId || !premisesId) {
  console.error('usage: CS_TOKEN=... node scripts/measure.mjs <tenant> <premises>');
  process.exit(2);
}

async function timed(path) {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, { headers: { authorization: TOKEN } });
  const body = await res.arrayBuffer();
  return { ms: performance.now() - started, status: res.status, bytes: body.byteLength };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}

async function serial(name, path, runs = 20) {
  const results = [];
  for (let i = 0; i < runs; i += 1) results.push(await timed(path));
  const bad = results.filter((r) => r.status !== 200);
  const s = stats(results.map((r) => r.ms));
  console.log(
    `${name.padEnd(34)} p50 ${s.p50.toFixed(0).padStart(5)}ms  `
    + `p95 ${s.p95.toFixed(0).padStart(5)}ms  max ${s.max.toFixed(0).padStart(5)}ms  `
    + `${(results[0].bytes / 1024).toFixed(1).padStart(7)} KiB`
    + (bad.length ? `  ${bad.length} FAILED (${bad[0].status})` : ''),
  );
  return results;
}

/** Fires n requests at once, which is what a shift change looks like. */
async function concurrent(name, path, n) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: n }, () => timed(path)));
  const wall = performance.now() - started;
  const bad = results.filter((r) => r.status !== 200);
  const s = stats(results.map((r) => r.ms));
  console.log(
    `${name.padEnd(34)} p50 ${s.p50.toFixed(0).padStart(5)}ms  `
    + `p95 ${s.p95.toFixed(0).padStart(5)}ms  max ${s.max.toFixed(0).padStart(5)}ms  `
    + `wall ${wall.toFixed(0)}ms`
    + (bad.length ? `  ${bad.length}/${n} FAILED (${bad[0].status})` : `  ${n}/${n} ok`),
  );
  return results;
}

const site = `tenantId=${tenantId}&premisesId=${premisesId}`;

// Claim the session slot first. Reads are gated on holding it, and a token
// minted after another sign-in has displaced the stored session is refused —
// which looks exactly like a broken endpoint if you have not claimed it.
await fetch(`${API}/api/session`, {
  method: 'POST',
  headers: { authorization: TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ tenantId, premisesId }),
});

// The ids a full grid asks for, taken from the first page so they are real.
const firstPage = await fetch(`${API}/api/admin/cameras?${site}&limit=16`, {
  headers: { authorization: TOKEN },
}).then((r) => r.json());
if (!firstPage.cameras) {
  console.error('Could not list cameras:', JSON.stringify(firstPage));
  process.exit(1);
}
const ids = firstPage.cameras.map((c) => c.cameraId).join(',');
console.log(`Site holds ${firstPage.total} cameras.\n`);

console.log('— what the console asks for on one page —');
await serial('cameras, one grid page (16)', `/api/admin/cameras?${site}&limit=16`);
await serial('cameras, an admin page (25)', `/api/admin/cameras?${site}&limit=25`);
await serial('streams for those 16', `/api/streams?${site}&cameraIds=${ids}`);
await serial('agents at the site', `/api/admin/agents?${site}&limit=25`);
await serial('counts', `/api/admin/counts?${site}`);
await serial('search within the site', `/api/admin/search?${site}&q=loading`);
await serial('camera search', `/api/admin/cameras?${site}&q=loading&limit=25`);

console.log('\n— the shapes that used to be unbounded —');
await serial('cameras, the largest page (200)', `/api/admin/cameras?${site}&limit=200`);
await serial('users', '/api/admin/users?limit=25');

console.log('\n— everyone opening the console at once —');
await concurrent('40 concurrent grid pages', `/api/admin/cameras?${site}&limit=16`, 40);
await concurrent('100 concurrent grid pages', `/api/admin/cameras?${site}&limit=16`, 100);
await concurrent('100 concurrent stream reads', `/api/streams?${site}&cameraIds=${ids}`, 100);
