# Questions you will be asked, and short answers

Grouped by who asks them. The answers are deliberately short — enough to hold
the room, with a pointer to where the detail lives.

---

## From architects and senior engineers

**"We already have a working platform. Why rebuild?"**
It works; the objection is what it costs and where the risk sits. Three fixed
tiers — WildFly, EFS, Nginx — are paid for 365 days to serve 120–240, and are
sized for the two national exam days among them. And the delete
sweep already cannot keep up at peak, which is not a tuning problem but a sign
the storage layer is the wrong shape for a high-churn ring buffer.

**"Isn't S3 too slow for live video?"**
No, and the current design already proves it — you are writing to NFS over a
network. S3 `PutObject` for a 130 KB segment is tens of milliseconds; measured
here at 122 ms per segment including TLS on ordinary broadband, against a
10-second budget. The latency that matters to a viewer is segment duration and
player buffer, not the store.

**"What about the extra hop through CloudFront?"**
It removes hops rather than adding one. Today: viewer → Nginx → NFS → EFS.
Proposed: viewer → CloudFront edge (usually in-country, often in-city) → S3. The
edge is closer to the viewer than your region is.

**"S3 is eventually consistent — won't playlists serve stale segments?"**
S3 has been strongly read-after-write consistent for all operations since
December 2020. A segment is readable the moment `PutObject` returns. This
objection was correct until 2020 and is the most common out-of-date one you will
hear.

**"4,000 PUT/s to one bucket — will S3 throttle?"**
S3 sustains 3,500 PUT/s *per prefix* and partitions automatically as it learns
the key distribution. Keys are spread by thing name, so the load is spread by
construction. That said it is listed as unproven at scale — run a synthetic
writer at full rate against the real key shape before committing.
(`10-implementation.md` §7.)

**"What happens when a centre's internet drops?"**
The same as today: the agent buffers to local disk and catches up. Nothing
upstream needs to hold state for it, which is actually better than today —
there is no session on a WildFly instance to lose.

**"Vendor lock-in?"**
Real, and worth naming. The lock-in is IoT credentials provider and CloudFront
signed cookies. The video itself is plain HLS in object storage, portable to any
S3-compatible store; the agent and player are unchanged by a move. The bindings
are perhaps 300 lines. Weigh that against the operational lock-in of 50 hand-
sharded file systems.

**"Why not Kubernetes / ECS instead of Lambda?"**
Because the workload is 120–240 active days a year, and the peak that sizes it
is two of them. A container platform is provisioned capacity with a different name;
it would solve the sharding problem but not the paying-for-idle one. Lambda here
handles control plane only — no video passes through it.

---

## From security and compliance

**"Where do the camera passwords live?"**
On-premises only. The control plane holds them encrypted to a key only the agent
possesses, relays the envelope, and cannot read it. The RTSP URL — the thing
that embeds the credential — is assembled at the centre and exists nowhere else.
This is stronger than most current designs, where the credential is in a server-
side configuration.

**"What can a compromised agent do?"**
Corrupt its own centre's video. Nothing else. Its credentials are scoped by
`${credentials-iot:ThingName}` to its own prefix, it has `PutObject` and
`DeleteObject` but deliberately **no `GetObject`** — so it cannot read footage,
not even its own. Revocation is deactivating one certificate.

**"What can a leaked viewer cookie do?"**
Fifteen minutes of one centre. Cookies are short-lived, scoped to one resource
path, and refreshed by the player.

**"Who can see other centres' footage?"**
Only what the cookie's single resource statement permits. Note the trap
(`30-runbook.md` §7): a CloudFront policy carries exactly one resource, and the
naive workaround — a tenant-wide wildcard for anyone with multiple centres —
makes the restriction grant everything. Solved with a region/centre prefix
hierarchy decided before the first object is written.

**"Is footage encrypted?"**
At rest by S3 (SSE-S3 or SSE-KMS), in transit by TLS on every hop. If KMS is
required for compliance, note it adds a request cost per object — at 9 million
objects an hour, use SSE-S3 for segments and reserve SSE-KMS for archive.

**"Data residency?"**
Bucket in ap-south-1; CloudFront can be restricted to India-only edge locations
and geo-restricted to India. Both are configuration, not architecture.

**"How do we know the software on 1,500 agents is ours?"**
Update bundles are signed with a KMS asymmetric key whose private half never
leaves KMS; agents verify against a public key compiled into the binary and
refuse anything unsigned. Every use of the signing key raises an alarm. This is
built and verified end to end in the reference implementation.

---

## From finance

**"What does it cost?"**
~$13,700/year at 4-second segments, ~$22,700 at 2-second, against an estimated
~$314k for the current fleet. The gap is not efficiency — it is that nothing is
published unless somebody is watching it. (`20-cost.md` §5.)

**"Your comparison numbers for our platform are guesses."**
They are, and they are labelled as such. Replace them with actuals. If those EC2
instances are on 3-year Savings Plans the current figure may be ~40% lower — in
which case the honest recommendation is to migrate at renewal rather than now.

**"Where does the saving actually come from?"**
Dropping margin hours. Publishing continuously through shift plus margin costs
$65,016 a year at 10-second segments; publishing only what is watched costs
$13,700–22,700. That single change is worth **$42,000–51,000**, and it is worth
more than every encoder setting in the document combined.

**"So we are trading viewer experience for cost?"**
No — the opposite, and this is the point most worth making. A viewer who starts
their own stream sits about **6 seconds** behind live. A viewer joining a stream
that has been running all shift is governed by HLS's rule against starting
closer than three target durations to the live edge, and sits about **30 seconds**
behind. On demand is cheaper *and* fresher. Margin hours buy a permanent delay
in order to avoid a three-second wait.

**"Won't observers wait three seconds every time they open a camera?"**
Only if nothing anticipates them. Warm the streams when an observer opens a
**centre** rather than when they click a tile — by the time the grid renders,
they are running — and keep a stream alive 30–60 s after the last viewer so
flicking back is instant. With warming the perceived wait is zero. Without it,
3 s is the floor: RTSP negotiation and the wait for a keyframe dominate, and no
encoder setting removes them.

**"What's the biggest cost risk?"**
Viewer concurrency, which under on-demand is now the dominant variable rather
than an afterthought. **Count streams on screens, not people** — one observer
with a 25-tile grid is 25 streams, not one. If 500 concurrent streams is really
1,500, scenario A roughly triples.

**"Why not longer segments to cut requests further?"**
Because on-demand start breaks. A player that begins on the only available
segment holds `d0` seconds of media while the next takes `D` seconds to make, so
it runs dry for `D − d0`. Ten-second segments give a picture in four seconds and
then freeze it for eight — worse than waiting, because a stutter reads as broken
where a wait reads as loading. (`15-segments.md` §4.)

**"Could we ramp the segment length up instead?"**
No, and it is worth understanding why: playback consumes media at exactly the
rate production creates it, so a growing segment never accumulates buffer. It
only postpones the same arithmetic. Whatever the first few segments do, the
steady-state length decides whether the player runs dry.

**"Could we run two streams — a short one to start on and a long one to settle into?"**
Buildable, and it saves about $10,000 a year. One ffmpeg process writes both
outputs, and the short one is stopped ~20 s in or it costs more than it saves.
Not recommended, for four reasons: the handover has to fall 4–28 s backwards
because a player cannot be closer to live than the stream it is consuming; HLS
variant switching is bandwidth-driven so it needs custom player code; it adds a
failure mode at exactly the moment somebody is watching; and warming on centre
open already removes the cold start it exists to rescue. If it is ever built it
must be **one** process with two outputs — two processes means two RTSP sessions
per viewer, and cameras commonly cap those at two to four. (`15-segments.md` §6.)

**"What is the cheapest thing we can do to reduce it further?"**
Synthesise the playlist at read time with a CloudFront Function instead of
rewriting it per segment — half of all PUTs are small playlist rewrites, so it
removes ~$7,000 at 2-second segments. Worth doing, but no longer the headline it
was under continuous publishing.

**"What's the migration cost?"**
Not modelled, and it is a programme cost rather than an infrastructure one.
Running both platforms in parallel through a staged migration is real money and
real people. Budget it separately and honestly.

---

## From operations

**"Our delete sweep can't keep up. Does this fix it?"**
It removes the operation. There is no sweep: the agent deletes its own objects
as the playlist window rolls, S3 charges **nothing at all** for DELETE, and
there is no queue to fall behind on. A one-day lifecycle rule catches anything
orphaned by a crash. Under on-demand only watched cameras hold segments at all,
so the resident set is a few hundred megabytes across the estate at peak.

**"How do we know a centre is unwell before an exam?"**
Agents heartbeat health — CPU, memory, disk, uplink throughput, per-task health,
clock skew — and the console shows it. An agent that stops heartbeating raises an
alarm within 45 minutes. In practice the useful signal is clock skew and disk,
because those precede failures rather than reporting them.

**"What replaces our capacity planning?"**
Nothing, and that is the point. There is no fleet to size. The only planning left
is per-agent stream limits at unusually large centres.

**"Can we still run our own monitoring?"**
Yes. Everything emits CloudWatch metrics, and the registry is a DynamoDB table
you can read directly.

**"What if AWS has an outage?"**
Same exposure as today — you are already single-region on EC2 and EFS. This
design is *less* exposed in one respect: S3 and CloudFront have no instances to
lose, and an agent that cannot reach S3 buffers locally and catches up, where a
WildFly outage today drops the upload.

**"Are we keeping the existing agent?"**
No. It needs frequent restarts, leaks memory and sometimes does not run, and it
is the least reliable component in the platform — keeping it would spend the
migration on everything except the thing that fails. The Java 21 agent brings
supervision with retry and back-off, a watchdog that dumps threads when a task
hangs, resource telemetry that sheds work before a machine is exhausted, and
signed remote update. What carries across is the operational knowledge about
camera quirks, not the code.

**"Why does it have to be Java 21?"**
Virtual threads carry the per-camera concurrency, and the supervision model is
built on modern concurrency primitives. It is a requirement, not a preference,
and there is no plan to back-port to 8.

---

## From the integration team

**"Do we have to change our login?"**
No. You keep your users, your IdP and your rules. You call one server-to-server
endpoint after authenticating a user, and redirect their browser to the URL it
returns. We never see a password and hold no account for your users.

**"Why a redirect? Can't you just give us a cookie?"**
A cookie can only be set by the domain that serves the response. Your backend
cannot set a cookie on the CloudFront domain, so the browser has to touch our
origin once. Everything before that hop is server-to-server.

**"We have 25,000 mappings. Are these APIs per record?"**
No — batch only, deliberately, up to 500 per call with per-item results.
Individual-record endpoints are not offered because 25,000 sequential HTTP calls
is a four-hour job that fails halfway.

**"What if we push a MAC the estate hasn't discovered?"**
It returns `unresolved`, which is a normal outcome and not an error — the agent
may not have swept yet, or the camera may be unplugged. It resolves on the next
sweep, and the reconciliation endpoint is how you find out.

**"Who owns premises and roll-number mapping?"**
You do, unchanged. You push; we expose our view back for reconciliation. A
nightly diff alerting on mismatch is what catches silent drift — push-only
systems drift, and the first anyone notices is a camera on the wrong seat range
during an exam.

---

## The hard ones

**"You've only run this on two agents. Why should we believe 1,500?"**
You shouldn't, on my say-so. Four things are explicitly listed as unproven at
scale, with what to test (`10-implementation.md` §7). What two agents *did* prove
is the mechanism: certificate-to-credentials-to-S3, signed cookies, remote
signed update, on-premises credential handling. Those are the parts that are
hard to get right, and they are right. The parts that remain are load
characteristics, and load is testable in an afternoon with a simulator.

**"What did you get wrong building it?"**
Several things worth knowing, because they are the ones you would hit too. A
misparsed resolution inverted main and sub and served full-resolution video to
every grid tile — 1.78 MB segments instead of 52 KB, invisible except on the
bill. Two concurrent discovery sweeps corrupted each other's results and looked
like flaky hardware. An alarm was built that could never fire, and was only
caught by deliberately triggering the condition. Every one of those is now a
test. That history is the argument for the design review being about failure
modes rather than diagrams.

**"What would make you recommend against this?"**
If footage must be retained for years, the storage bill dominates and the
architecture matters less than the storage class — the interesting conversation
becomes Glacier tiering. If sub-second latency is required, HLS is the wrong
protocol entirely and you want WebRTC. And if the EC2 fleet is on unexpired
three-year commitments, migrating now means paying twice; wait for renewal.

**"How long?"**
The mechanism, proven in a scratch account: a day (`30-runbook.md`). One
existing Java 1.8 agent adapted to write to S3: days, not weeks — it is a
change of destination, not of design. A pilot of five centres through a full
exam cycle: one exam cycle, and there is no way to compress that because the
thing being tested is an exam. Migration of 800 centres: staged in batches of
50, and the pace is set by site logistics rather than by software.
