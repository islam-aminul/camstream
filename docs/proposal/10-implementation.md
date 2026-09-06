# Detailed implementation

Companion to `00-high-level.md`. This is what actually gets built, in enough
detail to argue with.

## 1. Components

| Component | Service | Why this one |
|---|---|---|
| Segment store | S3 | No capacity to provision, no shard map, per-prefix scaling is automatic |
| Delivery | CloudFront | Edge TLS, signed-cookie authorisation checked before the origin, one domain for the whole country |
| Control plane | API Gateway (HTTP API) + Lambda | Request-priced; idle between exams costs nothing |
| Registry | DynamoDB, single table | Single-digit-ms reads at any row count; on-demand capacity |
| Agent channel | AWS IoT Core (MQTT) | Per-device X.509 identity, presence events for free, no polling |
| Agent credentials | IoT credentials provider | Certificate exchanged for temporary, prefix-scoped AWS credentials |
| Console auth | Cognito | Only for *our* operators; exam users stay in the integration's IdP |
| Release signing | KMS, ECC_NIST_P256 | Private half never leaves KMS; agents verify against a compiled-in public key |

Nothing in the video path is priced per provisioned hour. That is the point of
the table.

## 2. The agent

**Java 21**, one process per centre, installed as a Windows service or a systemd
unit. It replaces the existing Java 1.8 agent rather than extending it — see
§2.1 for why that is a benefit rather than a cost. Responsibilities:

1. **Discover** cameras on the LAN — ONVIF WS-Discovery where available, then a
   bounded port sweep and RTSP path guessing where it is not. Recorder channels
   are walked rather than assumed.
2. **Publish** HLS. `ffmpeg` with `-c copy`: no re-encode, so roughly 2–5% of a
   core per stream rather than a core per stream.
3. **Upload** each segment to S3 under its own prefix, using credentials from
   the IoT credentials provider.
4. **Report** what it can see, and heartbeat health — CPU, memory, disk, uplink
   throughput, per-task health — so a centre that is unwell says so before
   somebody notices a black tile.
5. **Update itself** on instruction, from a signed bundle it verifies before
   opening the archive.

### 2.1 The agent is replaced, and that is a reason for the project

An earlier draft of this document argued for keeping the existing Java 1.8
agent, on the grounds that the AWS SDK supports Java 8 and the change would be
small. **That was wrong, and it had the argument exactly backwards.**

The existing agent needs frequent restarts to keep working, leaks memory, and
sometimes does not run at all. It is the least reliable component in the
platform. Preserving it would preserve the problem and spend the migration
budget on everything except the thing that actually fails.

So the agent is replaced with the Java 21 one, and the supervision it brings is
a headline benefit rather than an implementation detail:

| Failure today | What the new agent does |
|---|---|
| Needs frequent restarts | Every subsystem runs under a `Supervisor` that catches, logs, backs off and retries. A task that throws does not take the process with it |
| Silently stops working | A watchdog on its own thread notices any task that has gone in and not come out, and logs a full thread dump. Its own thread, deliberately — a wedged task holds a pool thread, so a watchdog sharing that pool would go quiet with it |
| Memory leaks | Heap, disk, CPU and uplink are sampled and reported on every heartbeat, with a resource assessment that sheds transcodes before the machine is exhausted rather than after |
| "Sometimes doesn't work" and nobody knows | Per-task health — name, healthy, consecutive failures, last success — travels on the heartbeat and is visible per centre in the console |
| Fixing it means visiting the site | Signed remote update. Bundles are signed with a KMS key whose private half never leaves KMS; the agent verifies before opening the archive and refuses anything unsigned |
| Clock drift breaks S3 auth | Clock skew is measured and reported; the unit orders itself after time sync |

The reliability argument is the one to lead with in a review. Cost is the
headline number, but an examination platform where a centre's agent "sometimes
doesn't work" on exam morning is a different kind of problem, and it is the one
this replaces.

**What carries across is the operational knowledge, not the code.** The camera
quirks, the RTSP paths that work on particular firmware, the recorders that need
a channel walk — those are worth extracting from the old agent and folding into
the new one's discovery, and that is where the migration effort should go.

**Java 21 is a requirement, not a preference.** Virtual threads carry the
per-camera concurrency, and the supervision model above is built on modern
concurrency primitives. There is no plan to back-port it to 8.

### 2.2 Publishing is on demand, with no margin hours

A camera is published only while somebody is watching it. There are no shift
hours synced to agents, no margin, and no stream running for an audience that
does not exist.

This is the largest change from the current platform and it is worth being
precise about why it is not a compromise:

- **It is cheaper by roughly twentyfold.** Published camera-hours become
  viewer-stream-hours rather than camera-count × shift-hours.
- **It is a better viewer experience.** A viewer who starts their own stream
  sits at the live edge — about six seconds behind — where a viewer joining a
  continuously running stream is governed by the three-target-duration rule and
  sits thirty seconds behind. `15-segments.md` §4.

**The requirement is that nobody waits for the feed**, and that is met by
anticipation rather than by leaving streams running:

| Mechanism | Effect |
|---|---|
| Warm on **centre open**, not tile click | The grid renders into streams that are already running. Absorbs the whole 3 s |
| **Linger** 30–60 s after the last viewer | Flicking away and back is instant |
| Warm an observer's **assigned centres at login** | They are assigned to a few; those are what they open |

Measured cold start is 3.0 s to first frame with `hls_init_time 1`, dominated by
RTSP negotiation and the wait for a keyframe. Warming removes it from the user's
perception entirely; without warming, 3 s is the floor and no encoder setting
gets below it.

**Segment length follows from on-demand, and it is short.** 2 seconds, because a
player that starts on the only available segment runs dry for `D − d0` while the
next one is produced — a 10-second steady segment gives a picture in four
seconds and then freezes it for eight. `15-segments.md` §4.

**Enforce stream stop server-side.** Under on-demand, "the stream ends when its
last viewer leaves" is what bounds the entire bill. If that lives only in the
agent, one stuck viewer session publishes overnight. It is the one cost control
that is genuinely load-bearing.

### 2.3 Deletion, which is your current operational pain

A single-threaded `find -mtime` that cannot finish during peak is not a tuning
problem. It is what happens when a POSIX file system is used as a high-churn
ring buffer while it is also serving every viewer, and deletes are scheduled
below reads.

On S3 this operation does not exist as a problem:

- **DELETE requests are free.** Not cheap — free. There is no cost line for
  removing objects at any rate.
- **There is no sweep.** The agent already tracks its own sliding window to
  write the playlist; deleting the object that just fell out of it is the same
  loop, not a separate scanner racing the writers.
- **`DeleteObjects` batches up to 1,000 keys per call**, so even a catch-up
  after an outage is a handful of requests.
- **A one-day lifecycle rule is the backstop** for objects orphaned by a crash,
  which is the only case the agent cannot clean up itself.

On-demand publishing shrinks it again, because only watched cameras hold
segments at all: a few hundred megabytes across the estate at peak. Fifty EFS
file systems are replaced by an object-storage line too small to appear on a
bill.

### Segment length

| | Current platform | Proposal |
|---|---|---|
| Steady state | 10 s | **2 s** |
| First segment | 10 s | **1 s** (`hls_init_time`) |
| Publishing | Continuous, shift + margin | **On demand** |

Short segments are a consequence of on-demand, not a preference. A player that
starts on the only available segment runs dry for `D − d0` while the next one is
made, so a 10-second steady segment stalls it for eight seconds immediately
after the first frame.

**Ramping between lengths does not help.** Playback consumes media at the rate
production creates it, so a growing segment never accumulates buffer — it only
postpones the same arithmetic. `15-segments.md` §4.

Both projects chose correctly for their own model, and the proposal takes one
setting from each. The agent already supports both: `segmentDurationMs` is
validated to 10,000 and `initialSegmentDurationMs` is independent of it.

### Renditions

- **sub** (typically 640×360, ~110 kbps measured) — what a grid pulls. Always
  the default.
- **main** (1080p) — only for a single expanded tile, because it is roughly
  20× the bytes.

A grid of 16 at main resolution is 20× the bill of a grid of 16 at sub, for a
picture nobody can see the detail of at 1/16th of a screen. The rule is enforced
in the control plane rather than left to the client.

## 3. Storage layout

```
s3://<live-bucket>/
  live/<thing-name>/<camera-id>/sub/index.m3u8
  live/<thing-name>/<camera-id>/sub/<n>.m4s
  live/<thing-name>/<camera-id>/main/index.m3u8
  live/<thing-name>/<camera-id>/master.m3u8
```

`<thing-name>` is `<tenant>--<centre>--<device>`, which makes the prefix both
the IAM boundary and the CloudFront cookie scope. One naming decision doing
three jobs is worth the slight ugliness.

**Lifecycle:** the agent deletes its own segments as the playlist window rolls
— DELETE is free and needs no sweep. At 2-second segments and a four-segment
window that is about 8 seconds of media per watched stream. A 1-day lifecycle
rule is the backstop for objects orphaned by a crash, which is the only case the
agent cannot clean up itself; S3 lifecycle granularity is one day, so it can
only ever be a backstop.

**There is no archive in this path**, and today you do not keep one. If retention is ever required, it is a *separate*
path: the agent writes 5-minute MP4 objects to a different prefix and a
different storage class (Glacier Instant Retrieval), not HLS segments. Writing
archive as segments would cost roughly 30× more in requests for identical bytes.
Worth knowing before somebody adds retention by extending the lifecycle rule on
the live prefix, which is the obvious move and the expensive one.

### Why not a prefix per centre with a shard map

There isn't one, and there does not need to be. S3 scales per prefix
automatically; the old EFS shard map exists because file systems have a fixed
size and a fixed throughput, and object storage does not. Removing the shard map
removes the rebalancing problem with it.

## 4. Data model

Single DynamoDB table, `pk`/`sk`, on-demand capacity.

| pk | sk | Holds |
|---|---|---|
| `TENANT#<t>#PREMISES#<centre>` | `DEVICE#<thing>` | Agent registration, version, connection state, camera count, clock skew |
| `TENANT#<t>#PREMISES#<centre>` | `CAMERA#<id>` | Approved camera: identity, display name, assigned agent, profile tokens |
| `TENANT#<t>#PREMISES#<centre>` | `DISCOVERED#<id>` | What an agent last saw on the LAN — IP, MAC, profiles |
| `TENANT#<t>#PREMISES#<centre>` | `LIVECAMERA#<thing>#<id>` | What is actually publishable now, with codec and manifest paths |
| `TENANT#<t>` | `HEALTH#<thing>` | Latest heartbeat. TTL 3 days |
| `TENANT#<t>#PREMISES#<centre>` | `DEMAND#` | What viewers currently have on screen |

Everything a screen needs is one query on one partition. There is no join and no
scan on any read path a user waits for.

**Why the centre is in the partition key:** the largest partition is one centre —
a few dozen cameras — not one tenant with 25,000. A tenant-wide partition would
be a hot key on exam morning and would eventually exceed the 10 GB partition
limit. This was already learned at small scale: an early tenant-wide listing
endpoint outgrew the Lambda response limit before the console could render it.

## 5. Integration contract

The integrating solution owns centres, premises, and roll-number-to-MAC mapping.
We own agents, cameras and video. The seam is four batch APIs and one redirect.

### 5.1 Authentication between the two systems

**Recommended: SigV4 against an IAM role** the integration assumes. It gives
CloudTrail attribution for free, rotates automatically, and needs no shared
secret in their configuration.

If the integration is not on AWS, the fallback is an HMAC signature over
`(method, path, sha256(body), timestamp)` with a key id in the header and keys
rotated on a schedule. Both are acceptable; do not accept a bare bearer token
that never expires.

### 5.2 Batch APIs — never one record at a time

Every endpoint takes or returns a page. Individual-record endpoints are
deliberately not offered: 25,000 cameras synced one HTTP call at a time is a
four-hour job that fails halfway.

```
POST /api/integration/centres:sync
  { "items": [ { "centreId": "4021", "name": "...", "state": "KA",
                 "address": {...} }, ... ] }         # up to 500 per call
  → 200 { "results": [ { "centreId": "4021", "status": "created" },
                        { "centreId": "4022", "status": "unchanged" },
                        { "centreId": "4023", "status": "rejected",
                          "reason": "unknown state code" } ] }
```

Per-item results, not an all-or-nothing 4xx. One bad row in a batch of 500 must
not discard the other 499, and the caller must be told exactly which one.

```
POST /api/integration/cameras:sync
  { "items": [ { "centreId": "4021", "mac": "EC:C8:9C:45:66:07",
                 "label": "Hall A - Front", "seatRange": "A1-A30" }, ... ] }
  → 200 { "results": [ { "mac": "...", "cameraId": "cam-…",
                          "status": "created" | "updated" | "unresolved" } ] }
```

`unresolved` is a first-class outcome, not an error: a MAC the estate has not
discovered yet is normal — the agent may not have swept, or the camera may not
be plugged in. It resolves itself on the next sweep, and the reconciliation
endpoint is how the integration finds out.

```
GET /api/integration/cameras?centreId=4021&cursor=…&limit=500
  → 200 { "items": [...], "cursor": "…" }
```

Cursor paging, not page numbers. Page 7 of a site with 25,000 cameras means
scanning the first six, and a cursor is what DynamoDB natively provides.

```
POST /api/integration/viewer-sessions
  { "user": { "id": "inv-1182", "name": "..." },
    "scope": { "centreIds": ["4021"] },
    "ttlSeconds": 900 }
  → 200 { "token": "…", "viewerUrl": "https://live.<domain>/session?t=…",
          "expiresAt": 1788672000 }
```

Called server-to-server *after* the integration has authenticated the user. We
never see their password and have no account for their users.

**Idempotency:** every `:sync` accepts an `Idempotency-Key` header. A retried
batch after a timeout must not create duplicates, and a network that times out
mid-batch is a certainty at this scale rather than a possibility.

### 5.3 Direction of sync

The integration **pushes**; we expose the same data back for **reconciliation**.

Push, because the integration knows the moment a mapping changes and we would
otherwise poll 800 centres for a change that happens twice a year. Reconciliation
as well, because push-only systems drift silently and the first anyone knows is a
camera on the wrong seat range during an exam. A nightly diff of both views,
alerting on mismatch, is cheap and is the thing that catches the drift.

### 5.4 The viewer redirect, and the cookie constraint

The mechanically important detail, and the one most likely to be got wrong:

**A CloudFront custom policy carries exactly one resource statement.** A viewer
authorised for several centres cannot be granted all of them in one cookie. This
was learned the hard way on the small system: an early version issued the
tenant-wide wildcard to anyone allowed more than one site, which made the
restriction grant everything it was meant to limit.

Two ways out, and the choice depends on how control rooms actually work:

1. **Re-mint per centre.** The cookie is cut to the centre being watched, and
   changing centre re-mints. Tightest grant; needs a round trip on switch.
2. **Hierarchical prefixes.** Key video as `live/<state>/<centre>/…` and grant
   `live/KA/*` to a state-level control room. One cookie for a region; the grant
   is coarser by exactly the amount the control room's remit is.

**Recommendation: both.** Prefix by region because a nationwide platform has
regional control rooms, and re-mint per centre for single-centre users. Decide
the prefix hierarchy before the first byte is written — it is in every object
key and changing it later is a migration.

Session cookies are short (15 minutes) and refreshed by the player. A leaked
cookie is then worth 15 minutes of one centre, not permanent access to the
country.

## 6. Security model

| Concern | Control |
|---|---|
| Agent identity | Per-device X.509, IoT credentials provider, role scoped by `${credentials-iot:ThingName}` |
| Agent blast radius | Write-only, own prefix only. Cannot read any centre including its own |
| Camera passwords | Encrypted to a key only the agent holds; the control plane relays and cannot decrypt |
| Viewer authorisation | CloudFront signed cookie, 15-minute TTL, scoped to one resource path |
| Operator access | Cognito, role-scoped, premises-scoped claims enforced on every listing |
| Update integrity | Bundles signed with a KMS asymmetric key; agents refuse unsigned packages |
| Signing key use | Every `kms:Sign` alarms to the ops topic — CloudTrail → log group → metric filter |
| Cross-site disclosure | Scope filters applied to responses, not only to actions |

That last row is worth reading twice. It is easy to check a caller's scope when
deciding what to *do* and forget to apply it to what you *return*; a listing that
leaks thing names leaks the list of centres, because the thing name contains the
centre. It has been got wrong twice on the small system and both are now tests.

## 7. What is unproven at scale

Stated plainly, because a proposal that claims everything is proven is not
worth reading.

**1,500 concurrent IoT connections and their message rate.** Proven: 2. IoT Core
handles far more, but the *pattern* — presence events driving DynamoDB writes,
desired-state fan-out on viewer change — has not been run at 1,500. Test with a
simulator publishing synthetic heartbeats before committing.

**S3 request rate on one bucket.** At 10-second segments and the 20,000-camera
national-exam peak, steady state is `20,000 × 720 / 3600` = **4,000 PUT/s** plus
2,000 DELETE/s. That is above the 3,500 PUT/s S3 sustains per prefix, so the key
distribution stops being academic. S3 sustains 3,500 PUT/s *per prefix* and scales
automatically as it learns the key distribution, and thing names spread the keys
naturally — so this should be comfortable. But "should be" is not a load test,
and the one thing that would break it is a key layout that puts a shared
high-cardinality component first. Run a synthetic writer at full rate against
the real key shape before committing.

**CloudFront cookie model with regional prefixes.** The single-resource
constraint is understood; how it feels for an observer switching between the few
centres they are assigned to is not. Your access pattern helps here — observers
are assigned to a small set of centres rather than roaming the country — so a
per-observer prefix grant may be simpler than either alternative. Prototype the
switch before building the console around it.

**DynamoDB on-demand ramp.** On-demand scales, but it scales *after* a burst.
An exam starting at 09:00 nationwide is a step function. Consider provisioned
capacity with scheduled scaling for exam days, which is cheaper as well as
safer under a known-in-advance peak.

**The agent at 30+ cameras per centre.** 20,000 cameras across 800 centres
averages ~25 per centre at national-exam peak, and this design has been measured
to 12 concurrent streams on modest hardware. Since publishing is continuous,
every camera at a centre is live for the whole shift — there is no demand-driven
relief. Your
existing agents already carry this load, so the risk is not the workload but
whether the S3 uploader keeps up with 31 streams × 6 segments/minute = ~3
uploads/second per agent. At the measured 122 ms per segment that is
comfortable, but measure it on the slowest centre uplink you have, not the
fastest.

## 8. Migration

Strangler, by centre, never big-bang.

1. Stand up the new platform empty. It costs almost nothing idle, so it can sit
   there during the whole migration.
2. Pick 5 centres of different sizes and network quality. Run **both** platforms
   at those centres simultaneously — the agent can publish to the new path while
   the old relay keeps uploading.
3. Compare for a full exam cycle: start-up latency, dropped segments, viewer
   complaints, cost per centre.
4. Move in batches of ~50 centres, each batch a week apart, with the previous
   batch still running on the old platform until the new one has survived an
   exam.
5. Decommission WildFly, EFS and Nginx only after a full exam cycle with zero
   centres on the old path.

The reason for batches of 50 rather than 800 at once is not caution about the
architecture; it is that 800 centres means 800 sites with their own firewalls,
uplinks and electricians, and the failures will be about those.
