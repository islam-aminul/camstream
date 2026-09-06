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

One process per centre, installed as a Windows service or a systemd unit. The
reference implementation is Java 21; **yours is Java 1.8 and does not need to
change** — see §2.1. Responsibilities either way:

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

### 2.1 You do not need to rewrite the agent

The largest de-risking fact in this proposal, and the easiest to miss.

Your agent is Java 1.8 driving FFmpeg. Keep it. **AWS SDK for Java 2.x supports
Java 8**, and so does the **AWS IoT Device SDK v2**. Everything this design asks
of the agent is available to you without a language or runtime migration:

| Today | Becomes | Effort |
|---|---|---|
| Multipart HTTP upload to WildFly | `S3Client.putObject` to a prefix | Small — it is the same bytes to a different endpoint |
| Long-lived credentials or none | `IotCredentialsProvider` from an X.509 cert | Small — one provider class, ~100 lines |
| Short-polling relay for sync | MQTT subscription (or keep polling at first) | Optional — can be phased |
| Local `find` delete sweep | `deleteObject` as the window rolls | Smaller than what it replaces |

The FFmpeg invocation does not change at all, because the output is still HLS
segments on local disk; only the uploader after it changes. That means the
riskiest component — the one that talks to 25,000 heterogeneous cameras and has
absorbed years of quirks — is not touched.

**Phase the MQTT part.** The short-polling relay can stay initially: it is
inefficient, not wrong. Moving segment upload to S3 is the change that removes
the WildFly and EFS tiers, and it can ship on its own. Command-and-control over
MQTT is a second, independent step.

### 2.2 Publishing is continuous, and that is costed honestly

You sync exam shift hours to agents and publish continuously through shift plus
margin, because the margin is what stops an observer waiting when they open a
camera. That requirement is respected here rather than assumed away.

The consequence is that publishing cost is fixed — ~$39,800/year across your
exam calendar, which is **89% of the entire bill** (`20-cost.md` §5). It does
not vary with viewers at all; all viewing together is 8%. Two things make that
affordable:

- **10-second segments.** Your existing choice, and a good one — it halves the
  request cost against a 4-second design, at the price of a few seconds of
  additional live delay that a monitoring workload can absorb.
- **Shift-bounded publishing.** Already how you operate. It is the difference
  between ~134 active days a year and 365.

Because publishing dominates so completely, the highest-value optimisation is on
the write path and nowhere else: synthesising the playlist at read time removes
half of all PUTs — **~$19,900, about 45% of the total** — and changes nothing an
observer can perceive.

**Enforce shift windows server-side as well as in the agent.** The agent
stopping at the end of a shift is what bounds the bill; if that is the only
control, one agent with a wrong clock publishes overnight and nobody notices
until the invoice. The control plane should refuse desired state outside a
centre's shift window. This is a cheap guard and it is the one cost control that
is genuinely load-bearing.

### 2.3 Deletion, which is your current operational pain

A single-threaded `find -mtime` that cannot finish during peak is not a tuning
problem. At your national-exam peak of 20,000 cameras and 10-second segments the
estate produces `20,000 × 360 = 7,200,000` objects an hour, and a 2-minute window
means deleting them at the same rate — 2 million unlinks an hour, on a file
system that schedules deletes below the reads it is also serving.

On S3 this operation does not exist as a problem:

- **DELETE requests are free.** Not cheap — free. There is no cost line for
  removing 7 million objects an hour.
- **There is no sweep.** The agent already tracks its own sliding window to
  write the playlist; deleting the object that just fell out of it is the same
  loop, not a separate scanner racing the writers.
- **`DeleteObjects` batches up to 1,000 keys per call**, so even a catch-up
  after an outage is a handful of requests.
- **A one-day lifecycle rule is the backstop** for objects orphaned by a crash,
  which is the only case the agent cannot clean up itself.

Resident storage across the whole estate at a 2-minute window is about **33 GB**
at the 20,000-camera peak. Fifty EFS file systems are replaced by an
object-storage line too small to appear on a bill.

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

**Lifecycle:** the agent deletes its own segments as the 2-minute window rolls
— DELETE is free and needs no sweep. A 1-day lifecycle rule is the backstop for
objects orphaned by a crash, which is the only case the agent cannot clean up
itself. S3 lifecycle granularity is one day, so it can only ever be a backstop;
the window itself has to be the agent's job.

**There is no archive in this path**, and today you do not keep one — files are
deleted after two minutes. If retention is ever required, it is a *separate*
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
