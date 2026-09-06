# Questions you will be asked, and short answers

Grouped by who asks them. The answers are deliberately short — enough to hold
the room, with a pointer to where the detail lives.

---

## From architects and senior engineers

**"We already have a working platform. Why rebuild?"**
It works; the objection is what it costs and where the risk sits. Three fixed
tiers — WildFly, EFS, Nginx — are paid for 365 days to serve about 134, and are
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
Because the workload is ~134 active days a year, and the peak that sizes it is
two of them. A container platform is provisioned capacity with a different name;
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
~$44,500/year across your whole exam calendar, or ~$24,600 with one read-path
optimisation, against an estimated ~$314k for the current fleet. But the ratio
is not the point — the current bill is identical in June and on exam morning,
because it is sized for two national exam days. (`20-cost.md` §5.)

**"Your comparison numbers for our platform are guesses."**
They are, and they are labelled as such. Replace them with actuals. If those EC2
instances are on 3-year Savings Plans the current figure may be ~40% lower — in
which case the honest recommendation is to migrate at renewal rather than now.

**"What's the biggest cost risk?"**
My reading of your exam calendar. Publishing is 89% of the bill and scales with
cameras × hours × days, and the monthly-exam pattern alone is 78% of the total.
If those 10 days a month are really 15, add ~$17,000. Everything else is noise
by comparison.

**"Surely bandwidth is the big number?"**
No, and this is the most useful thing in the costing. S3 **PUT requests are 89%**
of the bill; all viewing together is 8%. You publish 13–50 cameras for every one
being watched, so the write path dominates completely. Every instinct says
bandwidth; the arithmetic says requests.

**"So should we argue about viewer counts?"**
No — and it is worth saying so early to save the meeting. Tripling every viewer
number adds about $7,000 to a $44,500 bill.

**"Any way this costs more than expected?"**
Three: my calendar assumptions being wrong (above); anyone putting 1080p in a
grid, which is 20× per tile; and shift windows not enforced server-side, so an
agent with a wrong clock publishes overnight. The third is the one that is
genuinely load-bearing, and it is one guard in the control plane.

**"What is the cheapest thing we can do to reduce it?"**
Synthesise the HLS playlist at read time with a CloudFront Function instead of
rewriting it on every segment. Half of all PUTs are 1 KB playlist rewrites, so
this removes **~$19,900 — about 45% of the entire bill** — and changes nothing
an observer can perceive. One function, on the read path, at $0.10 per million
invocations.

**"What's the migration cost?"**
Not modelled, and it is a programme cost rather than an infrastructure one.
Running both platforms in parallel through a staged migration is real money and
real people. Budget it separately and honestly.

---

## From operations

**"Our delete sweep can't keep up. Does this fix it?"**
It removes the operation. There is no sweep: the agent deletes its own objects
as the 2-minute window rolls, S3 charges **nothing at all** for DELETE, and
there is no queue to fall behind on. A one-day lifecycle rule catches anything
orphaned by a crash. 33 GB resident across the whole estate at peak.

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
