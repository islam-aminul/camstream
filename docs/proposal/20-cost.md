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
| **10-second** segments | Halves request cost against a 4 s design |
| Margin hours pre-roll the feed | The reason on-demand is rejected: no start-up delay when an observer opens a camera |
| Files deleted after **2 minutes** | There is no archive in this path. Storage is a rounding error |
| Observers assigned to a few centres, overlapping on incidents | Viewer concurrency is the largest variable — §4 |

The continuous-publishing requirement is a genuine constraint and I am not going
to cost a design that ignores it. It costs roughly $43k/year at your scale, and
that is the price of an observer being able to flip between cameras with no
wait. Whether that is worth it is a product decision; §6 puts numbers on both
sides so it can be made deliberately.

## 2. Measured inputs

From the running system — real cameras, real network, stream-copied H.264:

| Quantity | Measured |
|---|---|
| Sub-stream segment | ~52 KB per 4 s → **~110 kbps** |
| Main-stream (1080p) | ~2 Mbps |
| Upload throughput | 484 KB/s, 122 ms per segment |
| Agent CPU per stream | 2–5% of one core |
| Start-up, click to first frame | ~3 s to first segment, ~9 s to picture |

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

**Assumed:** 60 exam days/year × 8 active hours = 480 hours.
Camera-hours: `25,000 × 480 = 12,000,000`.

```
  PUT   12,000,000 × 720 = 8.64e9  → /1,000 × $0.005 =  $43,200 / year
  DELETE                                              =        $0
  bytes 12,000,000 × 49.5 MB = 594 TB ingested        =        $0  (ingest is free)
  storage  25,000 × 110 kbps × 120 s ≈ 41 GB resident ≈       ~$1 / year
```

### The delete problem disappears, and it disappears for free

This is worth its own heading because it is your current operational pain.

A single-threaded `find -mtime` that cannot keep up during peak, on a file
system that deprioritises deletes, is not a tuning problem — it is what happens
when you ask a POSIX file system to sustain 2.5 million unlinks an hour
(`25,000 × 360 ÷ 3.6`) while it is also serving reads.

On S3 there is no such operation. **DELETE requests are not charged**, there is
no queue to fall behind on, and the agent deletes its own objects as its sliding
window rolls — the same code path that already manages the playlist. A one-day
lifecycle rule sits underneath as a backstop for anything orphaned by a crash.

The 2-minute window becomes 41 GB resident across the entire estate. Your 50
EFS file systems are replaced by about a pound a year of object storage.

### Halving the publish cost, if wanted

Half of all PUTs are playlist rewrites of about a kilobyte. A CloudFront
Function can synthesise the playlist at read time from the segment naming
convention, removing 360 PUT per camera-hour:

```
  with dynamic playlists   12,000,000 × 360 / 1,000 × $0.005 = $21,600 / year
```

$21,600 saved for one function on the read path at $0.10 per million
invocations. Worth doing, but not on day one — it adds a moving part to the path
that must not fail, and the baseline is affordable without it.

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

**Assumed — the number to challenge:** how many camera streams are on screens at
once. Three scenarios:

| Scenario | Concurrent streams | Egress | Requests | Origin GET | Total/year |
|---|---|---|---|---|---|
| Fixed observers only, partial grids | 5,000 | $12,100 | $2,100 | $700 | **~$14,900** |
| Half the estate watched | 12,500 | $28,200 | $5,200 | $1,700 | **~$35,100** |
| Every camera watched continuously | 25,000 | $55,200 | $10,400 | $3,500 | **~$69,100** |

**Your overlap works in your favour, and CloudFront is where it pays.** Fixed
observers plus incident viewers plus random exploration means the same centre is
often on several screens at once. Egress is per viewer regardless — that cannot
be avoided, every viewer downloads the bytes — but *origin* fetches collapse to
roughly one per object however many people watch. That is the difference between
your Nginx tier reading EFS once per viewer and CloudFront reading S3 once per
segment.

It is also why the origin-GET column above is small and roughly flat: it is
driven by how many distinct cameras are published and watched, not by how many
people are watching them.

## 5. Totals

| Line | Fixed observers (5,000) | All watched (25,000) |
|---|---|---|
| S3 PUT (publishing) | $43,200 | $43,200 |
| S3 DELETE | $0 | $0 |
| S3 storage (2-min window) | ~$1 | ~$1 |
| CloudFront egress + requests | $14,200 | $65,600 |
| S3 origin GET | $700 | $3,500 |
| IoT, DynamoDB, Lambda, API GW, KMS | ~$1,200 | ~$1,200 |
| **Total per year** | **~$59,300** | **~$113,500** |

With dynamic playlists (§3), subtract $21,600 from either: **~$37,700** or
**~$91,900**.

## 6. The on-demand question, answered rather than dodged

Publishing only what is watched would cut the $43,200 to roughly $4,300 at 10%
concurrency. You have rejected it, and the reason given — margin hours exist to
counter the initial feed delay — is a real one, not an implementation
preference. An observer who clicks a camera and waits nine seconds will not
trust the system.

Three middle positions, in case the saving is ever worth revisiting:

**Centre-level warm-up rather than camera-level.** Publish every camera at a
centre while any observer is logged in to that centre, and nothing when none
are. During a shift with an observer per centre this saves nothing; outside
shift hours, and at centres between shifts, it saves everything. It is strictly
better than continuous and never worse for latency within a watched centre.

**Shorter margin.** The margin exists because the first segment takes a
keyframe interval to appear. On this system the measured first-segment time is
~3 s using `hls_init_time` to cut the first segment at the first keyframe rather
than at the target duration. If your margin is currently minutes, most of it may
be recoverable by that one flag — worth measuring before it is costed.

**Accept it and move on.** $43,200/year is 14% of the current platform's
estimated fixed cost. This is not where the argument should be won.

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

Against **~$59,300–113,500/year** proposed. A ratio of roughly **3–5×**.

**The ratio is not the interesting part.** The current bill is identical in June
and on exam morning, because it is provisioned capacity. The proposed bill is
near zero between exams and rises only with shift hours actually run. For a
platform busy 60 days a year, paying for 365 is the structural problem, and
right-sizing instances does not fix it.

Three lines vanish rather than shrink: no ingest fleet, no NFS, no load balancer
in the video path. And one operational problem vanishes with them — the delete
sweep that cannot keep up.

## 8. What would make this wrong

**Bitrate.** Every byte line assumes ~110 kbps. If your cameras run at 512 kbps,
egress multiplies by 4.6. Measure one centre's actual segment sizes first; it is
a five-minute check and it moves the biggest variable line.

**Active hours.** 60 days × 8 hours is assumed. If shifts run 12 hours or there
are 120 exam days, publishing cost scales linearly.

**Viewer concurrency.** The spread in §4 is $14,900 to $69,100. Counting tiles
actually on screens, not observers, is the single most useful measurement you
can take before quoting a number.

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
