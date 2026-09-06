# Cost

## How to read this

Every number is **measured**, **derived**, or **assumed**, and labelled. The
assumed ones are the ones to argue about, and most are about your workload
rather than about AWS.

Prices are ap-south-1 (Mumbai), list, correct on 2026-09-06. They move. The
arithmetic is exposed so you can re-run it with today's numbers.

## 1. The target operating model

**This is the model for the new platform, and it is deliberately not the current
one.** The existing office platform syncs shift hours to agents, publishes
continuously through shift plus margin, and cannot serve on demand. That is what
is being replaced, and its constraints are not carried across.

| Requirement | Consequence |
|---|---|
| **Fully on demand** — no margin hours, nothing published unless watched | Publishing scales with viewers, not cameras. The largest single saving here |
| **A viewer must not wait for the feed** | Sets segment length and start-up design — §3 |
| **Viewers seldom watch the same camera** | CloudFront gives little cache offload; it earns its place on authorisation, TLS and edge latency instead — §4 |
| Live window only, no archive | Storage is a rounding error |

The two bold requirements pull against each other, and resolving them is the
substance of §3. Short answer: they are compatible, and the resolution is
**shorter** segments than the current platform uses, not longer.

## 2. Measured inputs

From the running system — real cameras, real network, stream-copied H.264:

| Quantity | Measured |
|---|---|
| Sub-stream segment | ~52 KB per 4 s → **~110 kbps** |
| Main-stream (1080p) | ~2 Mbps |
| Upload throughput | 484 KB/s, 122 ms per segment |
| Agent CPU per stream | 2–5% of one core |
| First frame, on-demand start | **3.0 s** with `hls_init_time 1` (6.4 s without) |

## 3. Segment length is a user-experience decision first

The instinct is to make segments long, because requests dominate cost. **With
on-demand publishing that instinct is wrong**, and the reason matters before any
number is quoted.

### 3.1 Why long segments break an on-demand start

A viewer's click starts ffmpeg. Moments later there is exactly one segment, so
the player begins on it — there is nothing else to buffer. That segment holds
`d0` seconds of media, and the *next* segment takes `D` seconds to produce.

The player therefore runs dry for **`D − d0`** seconds.

| Steady segment `D` | First segment `d0` | First frame | **Then stalls for** |
|---|---|---|---|
| 2 s | 2 s | 4.0 s | **0 s** |
| 4 s | 2 s | 4.0 s | 2 s |
| 6 s | 2 s | 4.0 s | 4 s |
| 10 s | 2 s | 4.0 s | **8 s** |
| 20 s | 2 s | 4.0 s | 18 s |

Ten-second segments give a picture in four seconds and then freeze it for eight.
That is worse than simply waiting, because a stutter reads as broken where a
wait reads as loading.

**This is also why a growing segment does not help.** Playback consumes media at
exactly the rate production creates it, so a ramp never accumulates buffer — it
only postpones the same arithmetic. The steady-state `D` decides whether the
player runs dry, whatever the first few segments did.

### 3.2 The live-edge trade, stated plainly

A player starting on the newest segment sits at the live edge with almost no
margin, and any jitter becomes a stall. A player starting three segments back
has `3 × D` of margin and is robust, but is `3 × D` behind live.

On-demand publishing puts every viewer in the first position, because their
click created the stream. That is what makes the first frame fast, and it is
also what makes long segments untenable — the same property seen from both ends.

**Short segments resolve it.** At 2 s the player settles about 6 s behind live
with segment-sized margin; at 4 s, about 12 s. Both are well inside what
invigilation needs, and neither stalls.

### 3.3 Recommendation

| Setting | Value | Why |
|---|---|---|
| `hls_time` | **2 s** | No stall on start; ~6 s behind live once settled |
| `hls_init_time` | **1 s** | First frame at 3.0 s rather than 6.4 s |
| Camera GOP | **1–2 s** | ffmpeg cuts at the first keyframe *past* the target, so the GOP quantises everything. A 2 s GOP against a 2 s target is exact |
| `hls_list_size` | **4** | Enough window to survive a hiccup without holding stale media |

4 s is the reasonable alternative: half the request cost, one 2-second settling
stall, ~12 s behind live. Both are priced in §5.

### 3.4 Making "no wait" true, not just fast

Three seconds is good. Zero is better, and it comes from anticipation rather
than from tuning:

- **Warm on centre open, not on tile click.** An observer opening a centre is
  about to watch its cameras. Start them then — by the time the grid renders,
  the streams are running. This is the single most effective change and it costs
  nothing extra, because those cameras were about to be published anyway.
- **Linger after the last viewer.** Keep a stream alive 30–60 s after nobody is
  watching, so flicking between cameras and coming back is instant. Costed as
  the 1.2× allowance in §5.
- **Warm an observer's assigned centres at login.** They are assigned to a few;
  those are the ones they will open.

With warming, the 3 s start-up is absorbed before the user asks for anything,
and the perceived wait is zero. Without it, 3 s is the floor — RTSP connect and
the first keyframe dominate, and no segment setting removes them.

## 4. What CloudFront is worth when viewers do not overlap

Worth stating plainly, because the usual argument for a CDN does not apply here.

Your viewers seldom watch the same camera, so CloudFront's cache does **not**
collapse many viewers into one origin read — most objects are fetched once from
S3 and delivered once. The offload benefit is close to zero, and §5 prices
origin GETs on that basis rather than on an optimistic hit ratio.

What CloudFront is actually bought for:

- **Authorisation at the edge.** Signed cookies are checked before a request
  reaches S3, so an unauthorised viewer costs nothing and touches nothing.
- **TLS termination close to the viewer**, which matters across a country.
- **One domain and one certificate** for the whole estate.
- **Not paying for an Nginx fleet** to do the above.

Still worth it — but not *for caching*, and a review assuming a high hit ratio
will be disappointed.

## 5. The annual calendar, costed

| | Cameras | Hours/day | Days/year | Concurrent viewer streams |
|---|---|---|---|---|
| **A** Monthly exams | 10,000 | 8 | 120 (10/month) | 500 |
| **B** Multi-shift | 5,000 | 10 | 120 (10/month) | 100 |
| **C** Two national exams | 20,000 | 12 | 2 + 2 mock days | 1,500 / 750 on mock |

**Under on-demand publishing the camera count no longer drives cost — the viewer
count does.** A camera nobody is watching is not published and is not billed.
Published camera-hours are viewer-stream-hours plus an allowance for switching
and for keeping a stream warm after the last viewer leaves:

```
  viewer-stream-hours/year          654,000
  × 1.2  switching and keep-warm
  = published camera-hours          784,800
```

### At 2-second segments — recommended

| | Publishing | Egress | CF requests | Origin GET | **Subtotal** |
|---|---|---|---|---|---|
| **A** | $10,368 | $2,529 | $2,074 | $829 | **$15,800** |
| **B** | $2,592 | $632 | $518 | $207 | **$3,949** |
| **C** | $1,166 | $285 | $233 | $93 | **$1,777** |
| | **$14,126** | **$3,446** | **$2,825** | **$1,129** | **$21,526** |

Plus ~$1,200 control plane and ~$1 storage.

> ### **Total: ~$22,700 per year**

### At 4-second segments

| | Publishing | Egress | CF requests | Origin GET | **Subtotal** |
|---|---|---|---|---|---|
| **A** | $5,184 | $2,529 | $1,037 | $415 | **$9,165** |
| **B** | $1,296 | $632 | $259 | $104 | **$2,291** |
| **C** | $583 | $285 | $117 | $47 | **$1,032** |
| | **$7,063** | **$3,446** | **$1,413** | **$565** | **$12,487** |

> ### **Total: ~$13,700 per year**

### What dropping margin hours is worth

| Model | Segment | Total/year |
|---|---|---|
| Continuous, shift + margin | 10 s | $65,016 |
| Continuous, shift + margin | 4 s | $155,570 |
| **On demand** | **4 s** | **$13,687** |
| **On demand** | **2 s** | **$22,728** |

Publishing only what is watched is worth **$42,000–51,000 a year**, and it
simultaneously produces a *better* viewer experience — every viewer starts their
own stream at the live edge instead of joining one already thirty seconds
behind.

That is unusual and worth saying out loud in a review: **this is not a
cost-versus-quality trade. The cheaper option is also the better one.**

### Where the money goes now

Publishing is 62% at 2 s and 52% at 4 s — no longer the overwhelming share it
was under continuous publishing, because the base shrank twentyfold. Egress is
now a meaningful 15–25%, and it is the line that does *not* shrink with segment
length, because bytes are bytes.

**Dynamic playlists** — synthesising `index.m3u8` at read time rather than
rewriting it per segment — would halve the publishing line, saving ~$7,000 at
2 s. Worth doing eventually; no longer the headline it was under continuous
publishing.

## 6. Comparison with the current platform

**These are assumptions about your system and are the weakest numbers here.**
Replace them with actuals; the shape matters more than the values.

| Item | Assumed | Monthly | Yearly |
|---|---|---|---|
| 50 × WildFly (m5.xlarge, on-demand) | $0.204/h | $7,446 | $89,352 |
| 20 × Nginx (c5.large) | $0.098/h | $1,431 | $17,172 |
| ALB + LCU (video through the balancer) | | ~$450 | $5,400 |
| 50 × EFS, 50 TB total (Standard) | $0.30/GB-mo | $15,360 | $184,320 |
| EBS, NAT, inter-AZ transfer | | ~$1,500 | $18,000 |
| **Total** | | **~$26,200** | **~$314,000** |

**Egress is excluded from both sides.** You pay it today from EC2 and would pay
it from CloudFront at comparable rates; on one side only it would mislead, and
on both it changes nothing.

Against **~$13,700–22,700/year** proposed — a ratio of roughly **14–23×**.

The ratio is not the interesting part. The current bill is identical in June and
on exam morning because it is provisioned capacity sized for two national exam
days. The proposed bill is near zero between exams and rises only with what
somebody is actually watching.

Three lines vanish rather than shrink — no ingest fleet, no NFS, no load
balancer in the video path — and one operational problem vanishes with them.

## 7. The delete problem, and why it disappears

Your `find -mtime` cannot finish during peak because EFS schedules deletes below
the reads it is also serving, and you are asking it to sustain millions of
unlinks an hour.

On S3 the operation does not exist as a problem:

- **DELETE requests are not charged.** Not cheap — free.
- **There is no sweep.** The agent already tracks its sliding window to write
  the playlist; deleting what falls out of it is the same loop, not a scanner
  racing the writers.
- **`DeleteObjects` batches 1,000 keys per call**, so catching up after an
  outage is a handful of requests.
- **A one-day lifecycle rule** is the backstop for objects orphaned by a crash.

Under on-demand publishing the resident set is smaller again, because only
watched cameras hold segments at all: at 2-second segments and a four-segment
window, roughly **8 seconds of media per watched stream** — a few hundred
megabytes across the estate at peak.

## 8. What would make this wrong

**Viewer concurrency is now the dominant variable**, the opposite of the
continuous model. Publishing scales with viewers, so if 500 concurrent streams
is really 1,500, scenario A roughly triples. **Count streams on screens, not
people** — one observer with a 25-tile grid is 25 streams.

**Keep-warm and switching overhead.** I assumed 1.2×. If observers flick between
cameras constantly, or streams are kept warm for minutes, this rises. It is
measurable from day one and worth instrumenting before it is assumed.

**Bitrate.** Every byte line assumes ~110 kbps. Egress is now 15–25% of the
bill, so a 512 kbps estate would add roughly $11,000. Measure one centre's real
segment sizes; it is a five-minute check.

**My assumptions about your current platform.** Instance types, counts and EFS
sizing in §6 are guesses.

**Migration cost.** Not modelled — a programme cost rather than an
infrastructure one.

## 9. Cost controls to build in from day one

- **Server-side enforcement that a stream stops when its last viewer leaves.**
  Under on-demand this bounds the entire bill and is load-bearing in a way
  nothing else here is.
- **A hard per-agent stream ceiling**, so one misconfigured centre cannot
  publish 200 streams.
- **`main` gated to one expanded tile.** A 1080p stream is ~20× a sub stream.
- **Billing alarm per environment**, and a dashboard of PUT rate rather than
  spend — spend lags by a day, request rate tells you in minutes.
- **Cost allocation tags per centre**, so "which centres cost most" is a query.
