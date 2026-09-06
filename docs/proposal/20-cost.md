# Cost

## How to read this

Every number is **measured**, **derived**, or **assumed**, and labelled. The
assumed ones are the ones to argue about, and most are about your workload
rather than about AWS.

Prices are ap-south-1 (Mumbai), list, correct on 2026-09-06. They move. The
arithmetic is exposed so you can re-run it with today's numbers.

## 1. The operating model this is costed against

Not the one I assumed first. This is what you actually do:

| Fact | Consequence |
|---|---|
| Exam shift hours are synced to agents | Publishing is bounded to shift + margin, not 24×7 |
| Agents publish **continuously** through the shift | On-demand publishing is off the table — see §6 |
| **10-second** segments | Your choice, and the proposal keeps it — see §3.1. It is worth $89,000/year against the 4 s this project defaults to |
| Margin hours pre-roll the feed | The reason on-demand is rejected: no start-up delay when an observer opens a camera |
| Files deleted after **2 minutes** | There is no archive in this path. Storage is a rounding error |
| Observers assigned to a few centres, overlapping on incidents | Viewer concurrency is the largest variable — §4 |

The continuous-publishing requirement is a genuine constraint and I am not going
to cost a design that ignores it. It is ~92% of the bill, and it is the price of
an observer being able to flip between cameras with no wait. Whether that is
worth it is a product decision; §6 puts numbers on both sides so it can be made
deliberately rather than by default.

Sections 3 and 4 give the per-unit rates. §5 applies them to your actual exam
calendar.

## 2. Measured inputs

From the running system — real cameras, real network, stream-copied H.264:

| Quantity | Measured |
|---|---|
| Sub-stream segment | ~52 KB per 4 s → **~110 kbps** |
| Main-stream (1080p) | ~2 Mbps |
| Upload throughput | 484 KB/s, 122 ms per segment |
| Agent CPU per stream | 2–5% of one core |
| Start-up, click to first frame | ~3 s to first segment, ~9 s to picture |
| Segment length **in this project** | 1 s first segment, then 4 s |
| Segment length **in your platform** | 10 s throughout |

The two projects chose differently and both were right for their own model. This
project publishes **on demand**, so a viewer clicks and waits — short segments
and a keyframe-aligned first segment are what make that bearable. You publish
**continuously with a margin**, so nobody ever waits for a first segment, and
short ones buy you nothing while costing a great deal. §3.1 has the numbers.

**Assumed:** your streams are comparable at ~110 kbps. If your cameras are
configured higher, scale every byte-based line proportionally — the request
lines do not move.

## 3. Publishing — the fixed cost

At 10-second segments:

```
  segments per camera-hour      3600 / 10        =  360
  playlist rewrites             one per segment  =  360
  ----------------------------------------------------
  S3 PUT per camera-hour                         =  720
  S3 DELETE per camera-hour     (2-min window)   =  360   ← free
  bytes per camera-hour         110 kbps × 3600  =  49.5 MB
```

So one camera-hour of publishing costs:

```
  PUT      720 / 1,000 × $0.005  =  $0.0036
  DELETE                            $0        (S3 does not charge for DELETE)
  ingest   49.5 MB                  $0        (uploads to S3 are free)
  ------------------------------------------
                                    $0.0036 per camera-hour
```

**$0.0036 per camera-hour is the number the whole platform is built on.**
Multiply it by your exam calendar in §5.

Storage is a rounding error at a 2-minute window: `cameras × 110 kbps × 120 s`,
so even the 20,000-camera peak is about **33 GB** resident across the estate —
under a pound a month.

### 3.1 Segment length is the single largest decision in this document

Everything above assumes your 10 seconds. **This project defaults to 4**, and if
that default were carried across unexamined it would cost $89,424 a year.

| Segment | PUT per camera-hour | Publishing | **Total/year** | With dynamic playlists |
|---|---|---|---|---|
| 4 s *(this project's default)* | 1,800 | $149,040 | **$155,570** | $81,050 |
| 6 s | 1,200 | $99,360 | **$105,263** | $55,583 |
| 8 s | 900 | $74,520 | **$80,109** | $42,849 |
| **10 s** *(yours — recommended)* | **720** | **$59,616** | **$65,016** | **$35,208** |

**Keep 10 seconds.** Not as a compromise — it is the right choice for your
model, and it is worth more than every other optimisation in this document
combined.

The reason the two projects differ is worth stating, because somebody will
otherwise assume the reference implementation's default is the considered one:

- **This project publishes on demand.** A viewer clicks a camera that is not
  running, and waits for ffmpeg to start, a keyframe to arrive, and a segment to
  be written. Segment length is directly in that wait, so 4 s is bought with
  money to save the viewer time.
- **You publish continuously with a margin.** By the time anyone opens a camera
  the stream has been running for the whole pre-roll. Segment length is not in
  the start-up path at all. Paying 2.5× the request cost to shorten a wait that
  does not exist would be pure waste.

The cost of 10 s is a few extra seconds of live delay — the viewer is further
behind real time. For invigilation that is immaterial; for anything requiring
interaction it would not be.

### 3.2 The one thing worth taking from this project's settings

The **first** segment, not the steady-state one.

`-hls_init_time 1` makes ffmpeg cut the first segment at the first keyframe
after one second rather than waiting for the full target duration. Measured here
against a 2-second-GOP camera, three runs each:

```
  hls_time 4 alone      6.1, 6.5, 6.6  ->  6.4 s to first frame
  + hls_init_time 2     4.7, 4.7, 5.7  ->  5.0 s
  + hls_init_time 1     2.5, 3.1, 3.4  ->  3.0 s
```

At a 10-second target the effect is larger still, because the first segment
would otherwise be a full ten seconds.

**This is what could shorten your margin hours.** The margin exists to absorb
the initial feed delay; more than half of that delay is the first segment. One
ffmpeg flag, no architectural change, and it costs one extra short object per
stream start — a rounding error against 720 per camera-hour.

Worth measuring on your own cameras before assuming the saving, because the
gain depends on GOP length. But it is a five-minute experiment on one centre and
the margin is billable time.

### The delete problem disappears, and it disappears for free

This is worth its own heading because it is your current operational pain.

A single-threaded `find -mtime` that cannot keep up during peak, on a file
system that deprioritises deletes, is not a tuning problem — it is what happens
when you ask a POSIX file system to sustain 2 million unlinks an hour at your
national-exam peak (`20,000 cameras × 360 ÷ 3.6`) while it is also serving every
viewer.

On S3 there is no such operation. **DELETE requests are not charged**, there is
no queue to fall behind on, and the agent deletes its own objects as its sliding
window rolls — the same code path that already manages the playlist. A one-day
lifecycle rule sits underneath as a backstop for anything orphaned by a crash.

The 2-minute window becomes about 33 GB resident at peak across the entire
estate. Your 50 EFS file systems are replaced by an object-storage line too
small to notice on a bill.

### Halving the publish cost, if wanted

Half of all PUTs are playlist rewrites of about a kilobyte. A CloudFront
Function can synthesise the playlist at read time from the segment naming
convention, removing 360 PUT per camera-hour:

Across the full calendar in §5 that is 16.56 million camera-hours, so:

```
  playlist PUTs removed   16,560,000 × 360 / 1,000 × $0.005 = $29,808 / year
```

**~$29,800 — about 46% of the entire bill — for one CloudFront Function** at
$0.10 per million invocations. At the assumed calendar this is by some distance
the highest-value optimisation available, and unlike §6 it changes nothing an
observer can perceive.

It does add a moving part to a read path that must not fail, so it is not a
day-one change. It is a fast follow.

## 4. Viewing — the variable cost

Per viewer-stream-hour at 10-second segments:

```
  egress    49.5 MB × ~$0.10/GB (tiered)   = $0.0050
  requests  720 / 10,000 × $0.0120         = $0.0009
  ------------------------------------------------
                                             $0.0059
```

Egress tiers down with volume (India: $0.1090/GB to 10 TB, $0.1050 to 50 TB,
$0.1020 to 150 TB, $0.0930 to 500 TB). At your volumes the blended rate is
~$0.095–0.102; I use $0.10.

So one viewer-hour of one camera costs **$0.0059** — of which egress is 85%.

**Your overlap works in your favour, and CloudFront is where it pays.** Fixed
observers plus incident viewers plus random exploration means the same centre is
often on several screens at once. Egress is per viewer regardless — every viewer
downloads the bytes, and nothing avoids that — but *origin* fetches collapse to
roughly one per object however many people watch.

That is the difference between your Nginx tier reading EFS once per viewer and
CloudFront reading S3 once per segment, and it is why the origin-GET column in
§5 stays under $160 across the whole year.

Note the asymmetry that falls out of §5: a viewer-hour costs $0.0059 and a
camera-hour of publishing costs $0.0036, but you publish 13–50 cameras for every
one watched. **Viewing is 6% of the bill; publishing is 92%.**

## 5. The annual calendar, costed

Three exam patterns, not one steady state. **Assumed interpretation — correct
me if wrong, it is one line to change:**

| | Cameras | Hours/day | Days/year | Concurrent viewers |
|---|---|---|---|---|
| **A** Monthly exams | 10,000 | 8 | 120 (10/month) | 500 |
| **B** Multi-shift | 5,000 | 10 | 120 (10/month) | 100 |
| **C** Two national exams | 20,000 | 12 | 2 + 2 mock days | 1,500 / 750 on mock |

**Estate size and concurrent load are different numbers.** The registered estate
is 25,000+ cameras; the figures above are how many are *publishing at once* in
each exam pattern. Nothing is billed for a registered camera that is not
publishing.

Applying the per-unit rates from §3 and §4:

| | Camera-hours | PUT cost | Egress | CF req | Origin GET | **Subtotal** |
|---|---|---|---|---|---|---|
| **A** | 9,600,000 | $34,560 | $2,529 | $415 | $138 | **$37,642** |
| **B** | 6,000,000 | $21,600 | $632 | $104 | $35 | **$22,371** |
| **C** | 960,000 | $3,456 | $285 | $47 | $16 | **$3,803** |
| | **16,560,000** | **$59,616** | **$3,446** | **$565** | **$188** | **$63,815** |

Plus ~$1,200 for the control plane (IoT, DynamoDB, Lambda, API Gateway, KMS)
and ~$1 for storage — the 2-minute window peaks at about 33 GB across the
estate.

> ### **Total: ~$65,000 per year**
> With dynamic playlists (§3): **~$35,200**

### 5.1 Three numbers that should change your mind

**PUT requests are 92% of the bill.** Not bandwidth, not storage, not compute.
All viewing together is 6% — under $4,200. Any effort spent optimising this
platform belongs on the write path and nowhere else.

**You publish between 13 and 50 cameras for every one being watched.**

| | Cameras | Viewers | Published : watched | Publishing cost | Per viewer |
|---|---|---|---|---|---|
| A | 10,000 | 500 | 20 : 1 | $34,560 | $69/yr |
| B | 5,000 | 100 | **50 : 1** | $21,600 | **$216/yr** |
| C | 20,000 | 1,500 | 13 : 1 | $3,456 | $2/yr |

**B is where the money is going and it is the least watched.** A third of the
annual bill publishes 5,000 cameras so that 100 people can look at them — $216
per observer per year, against $2 for the national exams. That is not an
argument that B is wrong; multi-shift exams may need every camera available on
demand. But it is the first place to point a cost review, and §6 puts a number
on the alternative.

**Scenario C is 6% of the bill.** The two national exams — the days everyone
worries about, the days the current fleet is sized for — cost $3,803 a year.
Under provisioned capacity those two days set the bill for all 365. Here they
cost what two days cost.

### 5.2 Peak rates, for the load test

| | Cameras live | Peak PUT/s | Peak DELETE/s | Aggregate ingest |
|---|---|---|---|---|
| A | 10,000 | 2,000 | 1,000 | 1.1 Gbps |
| B | 5,000 | 1,000 | 500 | 0.55 Gbps |
| A + B same days | 15,000 | 3,000 | 1,500 | 1.65 Gbps |
| C | 20,000 | **4,000** | 2,000 | 2.2 Gbps |

A and B both run ten days a month. **Whether they fall on the same days matters
for the load test, not for the bill** — camera-hours are camera-hours either
way, but concurrent load is 3,000 PUT/s if they coincide and 2,000 if they do
not. Worth knowing which, because it also decides whether your active calendar
is 120 days a year or 240.

**Scenario C exceeds the 3,500 PUT/s that S3 sustains per prefix**, so the key
distribution stops being academic. Keys are spread by thing name, which spreads
them across prefixes by construction — but this is precisely the case to load
test before a national exam rather than during one. It is an afternoon with a
synthetic writer.

Peak egress is trivial by comparison: 1,500 viewers at 110 kbps is 165 Mbps.
CloudFront will not notice.

## 6. On-demand: worth more than it was

You publish continuously because margin hours stop an observer waiting when
they open a camera. That is a real requirement and I am not going to cost a
design that ignores it.

But §5.1 changes the arithmetic, and scenario B changes it most. Publishing is
92% of the bill, and B alone spends $21,600 a year so that 100 people can watch
5,000 cameras — $216 per observer per year.

| Approach | A publish cost | B publish cost | Observer experience |
|---|---|---|---|
| Continuous (today) | $34,560 | $21,600 | Any camera instantly |
| Centre-level warm-up | × fraction of centres watched | × fraction of centres watched | Instant *within a watched centre* |
| Camera-level on demand | ~$1,700 | ~$430 | 3–9 s wait on first open |

**Centre-level warm-up is the one to look at**, and B is where to look first.
Publish every camera at a centre while any observer is logged in to that centre,
and nothing at centres with nobody on them. Within a watched centre the
experience is *identical* to today — an observer switching between cameras at
their own centre waits for nothing, because every camera there is already live.

The saving is exactly the fraction of centres with nobody watching, and that is
a number you can measure from existing access logs this week.

**Scenario B, 5,000 cameras ≈ 160 centres, 100 observers.** Those 100 observers
cannot be spread across more than 100 centres, so *at least* 37% of centres are
unwatched at any moment even in the worst case:

| Observers spread across | Saving | Per year |
|---|---|---|
| 100 centres (worst case) | 37% | **$8,000** |
| 60 centres | 62% | **$13,500** |
| 40 centres | 75% | **$16,200** |

**Scenario A, 10,000 cameras ≈ 320 centres, 500 observers:**

| Observers spread across | Saving | Per year |
|---|---|---|
| 250 centres | 22% | **$7,600** |
| 150 centres | 53% | **$18,300** |
| 80 centres | 75% | **$25,900** |

Taken together, centre-level warm-up is plausibly worth **$15,000–42,000 a
year** — a quarter to two thirds of the entire bill — with no change whatsoever
to what an observer experiences inside a centre they are watching.

Two supporting points:

**Your margin may be longer than it needs to be.** It exists because the first
segment takes a keyframe interval to appear. Measured here, `hls_init_time` cuts
the first segment at the first keyframe rather than at the target duration,
giving ~3 s to first segment. If your margin is currently measured in minutes,
most of it may be recoverable by one FFmpeg flag — worth measuring before it is
costed.

**Dynamic playlists are independent of all this** and save ~$29,800 on their
own — 46% of the bill — with no change to observer experience at all. They
compose with centre-level warm-up rather than competing with it: together the
two would take a $65,000 platform to somewhere near $20,000.

If only one optimisation is done, do the playlists. It is one CloudFront
Function, it needs no product decision, and nobody has to agree to anything.

## 7. Comparison with the current platform

**These are assumptions about your system and are the weakest numbers in this
document.** Replace them with your actuals; the shape matters more than the
values.

| Item | Assumed | Monthly | Yearly |
|---|---|---|---|
| 50 × WildFly (m5.xlarge, on-demand) | $0.204/h | $7,446 | $89,352 |
| 20 × Nginx (c5.large) | $0.098/h | $1,431 | $17,172 |
| ALB + LCU (video through the balancer) | | ~$450 | $5,400 |
| 50 × EFS, 50 TB total (Standard) | $0.30/GB-mo | $15,360 | $184,320 |
| EBS, NAT, inter-AZ transfer | | ~$1,500 | $18,000 |
| **Total** | | **~$26,200** | **~$314,000** |

**Egress is deliberately excluded from both sides.** You pay it today from EC2
and would pay it from CloudFront; the rates are close enough that including it
adds a large number to both columns and changes nothing. Do not let anyone
present a comparison that includes it on one side only.

Against **~$65,000/year** proposed, or **~$35,200** with dynamic playlists.
A ratio of roughly **5×**, or **9×** optimised.

**The fleet is sized for scenario C and idle for the rest of the year.** Your
national exams need capacity for 20,000 cameras on two days; scenario B needs a
quarter of that. Provisioned capacity has to be bought for the peak, so those
two days set the bill for all 365. In the proposed design scenario C costs
**$3,803** — 6% of the annual total — because two days is what you pay for.

**The ratio is not the interesting part.** The current bill is identical in June
and on exam morning, because it is provisioned capacity. The proposed bill is
near zero between exams and rises only with shift hours actually run. Your
calendar is 120–240 active days a year depending on whether A and B share days;
paying for 365, at a capacity set by two of them, is the structural problem, and
right-sizing instances does not fix it.

Three lines vanish rather than shrink: no ingest fleet, no NFS, no load balancer
in the video path. And one operational problem vanishes with them — the delete
sweep that cannot keep up.

## 8. What would make this wrong

**My reading of your exam calendar.** §5 has A and B both running 10 days every
month (120 days/year each) and C twice a year with a mock day each. Publishing
is 92% of the bill and scales linearly with cameras × hours × days, so a wrong
day count moves the total more than anything else here. Confirm it before
quoting.

**Bitrate.** Every byte line assumes ~110 kbps, but that only moves egress —
$3,446 of a $65,000 bill. Even at 512 kbps the total rises to about $77,000.
Publishing cost does not move at all, because it is request-driven. This is a
much smaller risk here than it would be in a bandwidth-dominated design.

**Camera counts per scenario.** Publishing is 92% of the bill and scales
linearly with cameras × hours × days. A and B are 58% and 34% of the total, so
if A is really 12,000 cameras rather than 10,000, add ~$7,000.

**Viewer concurrency barely matters.** At these ratios the entire viewing side
is $4,200 — 6%. Tripling every viewer count adds ~$8,000 to a $65,000 bill.
This is the opposite of what I assumed before seeing your numbers, and it is
worth saying plainly in the room: **do not spend the meeting arguing about
viewer counts.**

**My assumptions about your current platform.** Instance types, counts and EFS
sizing in §7 are guesses. If EFS holds 10 TB rather than 50, that comparison
narrows sharply — though the shape argument survives intact.

**Migration cost.** Not modelled. Running both platforms in parallel through a
staged migration is real money and real people, and it is a programme cost
rather than an infrastructure one.

**Reserved or Savings Plan pricing on the current fleet.** If those EC2
instances are on 3-year commitments, the current number is perhaps 40% lower
than §7 shows — and the sunk commitment is an argument for migrating at renewal
rather than immediately.

**S3 request pricing is the whole bill, so check it.** At 92% concentration, a
change in S3 request pricing moves this proposal more than anything else in it.
It has been stable for years, but it is the one line worth re-checking against
the calculator on the day you present.

## 9. Cost controls to build in from day one

Cheap now, painful to retrofit:

- **Billing alarm per environment.** A publish loop that does not stop when a
  shift ends is the failure mode that costs money quietly.
- **A dashboard of PUT rate, not just spend.** Spend lags by up to a day;
  request rate tells you within minutes.
- **Lifecycle rules from the first deploy**, even with agent-side deletion.
- **A hard per-agent stream ceiling** — already in the design, so one
  misconfigured centre cannot publish 200 streams.
- **`main` gated to one expanded tile**, enforced server-side. A 1080p grid is
  20× a sub grid.
- **Shift-hours enforcement server-side as well as in the agent.** The agent
  stopping at the end of a shift is what bounds the bill; make the control plane
  refuse desired state outside shift windows too, so one agent with a wrong
  clock cannot publish overnight.
- **Cost allocation tags per centre**, so "which centres cost most" is a query.
