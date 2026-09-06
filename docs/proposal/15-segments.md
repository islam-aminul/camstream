# Segments, playlists, and what a viewer sees

One-second first segment, two seconds thereafter, published on demand. This is
what that produces on disk, in the playlist, and on screen — and why a longer
steady segment would ruin it.

## 1. What ffmpeg does with the two settings

```
-hls_time 2           steady-state target
-hls_init_time 1      target for the first segment only
-hls_list_size 4      segments kept in the playlist
-hls_segment_type fmp4
```

**ffmpeg cuts at the first keyframe at or after the target**, never before. That
one sentence explains every number below, and it has two consequences that
surprise people.

**Segment length is quantised to the camera's GOP.** A 2-second target against a
2-second GOP gives exactly 2 s, one group of pictures. Against a 3.274-second
GOP it gives **3.274 s**, because there is no keyframe at 2 s and ffmpeg waits
for the next one — a 64% overshoot nobody asked for. The GOP, not the setting,
is what actually decides segment length.

**`hls_init_time` applies to the first segment only.** It is not a ramp. There is
no gradual 1 → 2 → 4 → 10 growth; there is one short segment and then steady
state. Measured on a real camera here (GOP 3.274 s, `hls_time 4`,
`hls_init_time 1`) the playlist read:

```
#EXTINF:3.274,     <- first segment: one GOP, the first keyframe past 1 s
#EXTINF:6.547,     <- steady state: two GOPs, the first keyframe past 4 s
```

A true ramp would need ffmpeg restarted between each length change, which means
an `EXT-X-DISCONTINUITY` and a visible stutter every time. It is not worth it,
and §4 shows it would buy nothing anyway.

### Set the camera GOP to divide the target

| Camera GOP | Target 2 s | Actual segment | Overshoot |
|---|---|---|---|
| 1 s | 2 s | 2.0 s | — |
| **2 s** | 2 s | **2.0 s** | — |
| 3.274 s | 2 s | 3.3 s | +64% |
| 4 s | 2 s | 4.0 s | +100% |

**Recommend a 1- or 2-second GOP on every camera.** It makes the target
meaningful, keeps the first segment to one GOP, and bounds how long a starting
viewer waits for a keyframe — which is most of the 3 seconds to first frame.
Cameras that cannot be configured overshoot and still work, but a configuration
sweep costs nothing and makes latency and request count predictable.

## 2. Segment sizes on disk

At the measured ~110 kbps sub-stream:

| Object | Duration | Size | Written |
|---|---|---|---|
| `<run>_init.mp4` | — | ~1 KB | Once per stream start |
| First segment | ~2 s (one GOP) | ~27 KB | Once |
| Steady segment | 2 s | ~27 KB | Every 2 s |
| `index.m3u8` | — | ~300 B | Every segment |

The init segment is fMP4's `moov` box — codec parameters and nothing else. It is
fetched once by each viewer and referenced by `EXT-X-MAP`. It must never be
deleted while the stream is live; deleting it breaks every player mid-stream,
which is a specific bug this project has already had and fixed.

Per camera-hour: 1,800 media segments + 1,800 playlist rewrites = **3,600 PUT**,
and ~49.5 MB. That is five times the request rate of a 10-second design — and it
still costs a fifth as much overall, because on-demand publishing shrinks the
number of camera-hours by twenty. `20-cost.md` §5.


## 3. What the playlist looks like, second by second

**At t ≈ 2 s**, the first segment has just been written:

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="a1b2_init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-09-06T09:00:02.000Z
#EXTINF:2.000,
a1b2_000000.m4s
```

One segment, and a viewer can start on it. That is the whole point of
`hls_init_time`: without it this playlist would not exist until t = 2 s at the
earliest and typically later, because ffmpeg would be waiting to fill a full
target duration.

**At t ≈ 8 s**, steady state with a four-segment window:

```
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:2.000,  a1b2_000001.m4s
#EXTINF:2.000,  a1b2_000002.m4s
#EXTINF:2.000,  a1b2_000003.m4s
#EXTINF:2.000,  a1b2_000004.m4s
```

`MEDIA-SEQUENCE` counts what has rolled out, which is how a player detects it
fell behind. The window holds 8 s of media; the agent deletes each segment as it
leaves, so the object store holds the window and little else.

Note `TARGETDURATION` never changes here, because the first segment is the same
length as the rest. At a 10-second target it would start at 2 and rise to 10 —
which RFC 8216 says a server should not do within a playlist. ffmpeg does it,
players tolerate it, and Apple's `mediastreamvalidator` flags it. Choosing a
first segment the same size as the steady one avoids the argument entirely.

## 4. What a viewer experiences

### The start

Their click starts ffmpeg, and nothing existed before it:

```
  0.0 s   ffmpeg starts, connects to the camera over RTSP
  ~1.2 s  RTSP negotiated, first keyframe arrives
  ~2.0 s  first segment written and uploaded          <- 27 KB
  ~3.0 s  player has playlist, init segment and media; picture appears
```

Measured here, three runs, 2-second-GOP camera: **3.0 s to first frame**.
Without `hls_init_time` the same stream took **6.4 s**, because the player had
to wait for a full-length segment.

The 3 seconds is dominated by RTSP negotiation and the wait for a keyframe.
**No segment setting removes them** — which is why §6 is about anticipating the
click rather than shaving the segment.

### Then: the stall that long segments cause

The player now holds `d0` seconds of media and the next segment takes `D`
seconds to produce. It runs dry for `D − d0`:

| Steady segment | First frame | **Then stalls for** | Settles behind live |
|---|---|---|---|
| **2 s** | 4.0 s | **0 s** | ~6 s |
| 4 s | 4.0 s | 2 s | ~12 s |
| 6 s | 4.0 s | 4 s | ~18 s |
| 10 s | 4.0 s | **8 s** | ~30 s |

A 10-second steady segment gives a picture in four seconds and then freezes it
for eight. That is worse than waiting, because a stutter reads as broken where a
wait reads as loading.

**A ramp does not fix this.** Playback consumes media at exactly the rate
production creates it, so a growing segment never accumulates buffer — it only
postpones the same arithmetic. Whatever the first few segments do, the
steady-state `D` decides whether the player runs dry.

### And why on-demand is the better experience, not the cheaper compromise

A stream that has been running for an hour is governed by a different rule: a
player joining it **should not start closer than three target durations from the
live edge** (RFC 8216 §6.3.3), because it needs media in hand to survive a
hiccup.

So the two publishing models give genuinely different experiences:

| | On demand | Continuous with margin |
|---|---|---|
| Who starts the stream | The viewer | Nobody — it is already running |
| First frame | ~3 s | Immediate |
| Behind live once playing | ~6 s at 2 s segments | `3 × TARGETDURATION`, so ~30 s at 10 s |
| What the short first segment buys | Everything | Nothing — it rolled out long ago |

Margin hours exist to remove a start-up wait. They replace a 3-second wait with
a permanent 30-second delay, and they publish 20 cameras for every one watched
to do it.

## 5. Segment length: the recommendation, and the alternative

| | 2 s *(recommended)* | 4 s |
|---|---|---|
| Stall after first segment | none | 2 s, once |
| Behind live | ~6 s | ~12 s |
| PUT per camera-hour | 3,600 | 1,800 |
| Annual total (`20-cost.md` §5) | ~$22,700 | ~$13,700 |

**2 seconds if the experience matters most**, which for an examination platform
it plausibly does — no stall, and an observer sees an incident six seconds after
it happens rather than thirty.

**4 seconds if $9,000 a year matters more** than one 2-second settling stall at
the start of each viewing session.

Both are cheaper than any continuous-publishing option by a wide margin, so this
is a comfortable decision rather than a painful one.

## 6. The two-stream idea: fast start and cheap steady state at once

Worth writing down properly, because it is the obvious next thought and it very
nearly works.

**The idea.** Publish two HLS renditions of the same camera: a short one
(1-second segments) that a viewer can start on instantly, and a long one
(10-second segments) that is cheap to run. The player begins on the short
stream and hands over to the long one once it is established.

### It is buildable, and cheaper

One ffmpeg process can write both outputs from a single input — no second
decode, and stream copy makes the extra output nearly free in CPU:

```
ffmpeg -rtsp_transport tcp -i rtsp://…  \
  -c copy -f hls -hls_time 1  … fast/index.m3u8 \
  -c copy -f hls -hls_time 10 … main/index.m3u8
```

**The short stream must be stopped after the handover**, or it costs more than
it saves: running both for a whole session is 7,920 PUT per camera-hour against
3,600 for 2-second segments throughout. Run it for the first ~20 seconds and it
becomes a rounding error.

| Approach | Annual cost | Behind live once settled |
|---|---|---|
| 2 s throughout *(recommended)* | $14,126 | ~6 s |
| 1 s burst → 4 s steady | $8,005 | ~12 s |
| 1 s burst → 10 s steady | $3,767 | ~30 s |

So it saves around **$10,000 a year**. That is real money and the idea deserves
a straight answer rather than a dismissal.

### Four reasons it is not recommended here

**1. The handover means falling backwards.** A player on the 1-second stream is
about 2 s behind real time. The 10-second stream's newest complete segment can
be up to 10 s old, and the three-segment rule puts a joining player 30 s back.
The player cannot be closer to live than the stream it is consuming, so the
handover has to lose 4–28 seconds — as a visible rewind, a deliberate slow-down
drift, or a stall. All three are noticeable, and they happen while the viewer is
looking at the tile.

**2. HLS has no native mechanism for it.** Variant switching in a master
playlist is driven by *bandwidth*, not by "I have been playing for twenty
seconds". Doing this needs custom player logic to swap the source and seek to
the right position. Custom player code is the most expensive kind: it has to
work in browsers you do not have, and it fails on exam morning rather than in
testing.

**3. It adds a failure mode exactly where you cannot afford one.** If the
handover fails, the viewer gets a stall or a black tile at the moment they are
watching. The single-stream design has no such moment.

**4. Warming already solves the problem it solves.** If a stream is started when
an observer opens a *centre* rather than when they click a tile, then by the
time they look at it the stream has been running for several seconds and has a
normal playlist. There is no cold start to rescue, so there is nothing for the
short stream to do. Warming costs one configuration decision; this costs a
player rewrite.

### One hard constraint worth knowing regardless

**Do not implement this as two ffmpeg processes.** That opens two RTSP sessions
to the camera, and cameras commonly cap concurrent sessions at two to four —
NVR channels often lower. This design already opens a second session when a
viewer expands a tile to main resolution, so a third would fail on constrained
hardware and reduce how many viewers a camera can serve. If it is ever built, it
must be one process with two outputs.

### When it would be worth revisiting

- If viewing sessions turn out to be very short and very frequent, so stream
  starts dominate.
- If observers are found to tolerate 30 seconds of latency, in which case the
  long stream can be long and the saving grows.
- If the platform grows several times, at which point $10,000 becomes
  proportionally more than the engineering it costs.

At today's numbers, $10,000 a year is roughly a fortnight of one engineer, and
the player work plus its testing plus a new exam-day failure mode is more than a
fortnight. **Two-second segments throughout get most of the benefit with none of
the risk.**

### The standard alternative, for completeness

Low-Latency HLS solves the same problem properly: partial segments are published
within an open segment, so a player gets sub-second latency *and* long segments.
It is a real standard with CloudFront support. It is not proposed here because
it multiplies request count substantially and invigilation does not need
sub-second latency — but it is the right answer if latency ever becomes a hard
requirement, and it is a better place to spend effort than a hand-rolled
handover.

## 7. Is the playlist synthesised, and would that help the start?

**No, it is not.** ffmpeg writes `index.m3u8` and the agent uploads it, once per
segment. Synthesising it at read time comes up twice in this proposal — as a
cost saving and as a latency lever — and the two cases have different answers.

### Where the three seconds actually goes

```
  0.0 s  ────────────  ffmpeg starts, RTSP negotiation
  1.2 s  ────          first keyframe arrives
  2.0 s  ──            first segment written and uploaded
       + up to 2.0 s   waiting for the player's next manifest poll   <- avoidable
       + ~1.0 s        fetch playlist, fetch init, fetch segment, decode
  ────────────────────────────────────────────────────────────────
  3.0 – 5.0 s to first frame
```

The first 2.0 seconds is RTSP negotiation and waiting for a keyframe. **Nothing
about playlists touches it.** Only warming (§8) removes it, by spending it
before the viewer asks.

The avoidable part is the middle line, and it is larger than the synthesis
question. On a cold start the manifest legitimately does not exist yet, so the
player 404s and retries — and in this project's player that retry is a **fixed
2000 ms**. If the first segment lands just after a poll, two seconds are simply
lost. The measured "3.0 s" is the lucky end of a 3.0–5.0 s range.

### So the ranking is not what the question implies

| Fix | Gain | Cost |
|---|---|---|
| **Poll faster while starting** (250–400 ms, backing off) | up to **1.75 s** | two lines of player code |
| **Warm on centre open** (§8) | the whole 3 s, from perception | one product decision |
| Agent writes a placeholder playlist at stream start | ~0.3 s, removes the 404 entirely | one PUT per stream start (~$24/yr) |
| Synthesise at the edge | ~0.2 s beyond the above | a Lambda on the hot path |

**Synthesis is last for latency**, because everything it would fix is fixed more
cheaply by the three rows above it. The 404-and-retry cycle is the problem, and
you do not need a Lambda to stop 404ing — you need the agent to write a playlist
a moment earlier, or the player to ask a moment more often.

### Synthesis for cost is a different question, and the answer is yes-but

Half of all PUTs are playlist rewrites of a few hundred bytes. Removing them:

```
  playlist PUTs saved   784,800 camera-hours × 1,800 / 1,000 × $0.005 = $7,063
```

The catch is *what* does the synthesising:

- **CloudFront Functions** cost almost nothing — 1.18 billion playlist requests
  a year is about **$118** — but they **cannot make network calls**. They cannot
  list a bucket or read a database, so they cannot know which segments actually
  exist. Synthesising from a naming convention alone means eventually emitting a
  playlist that references a segment that is not there, which the player sees as
  a 404 mid-stream.
- **Lambda@Edge** can do I/O: about **$711/year** at this request volume
  including duration. Net saving roughly **$6,350**.

So it pays for itself about ninefold. The reason it is still not proposed for
day one is that it puts a Lambda in front of **every playlist request on the
platform**. If it fails, every stream fails, and it fails during an exam rather
than during testing. Writing a small file to S3 has no such failure mode.

**Revisit it once the platform is boring**, not while it is being built.

### The real latency version of this idea is LL-HLS

If synthesis is wanted specifically for start-up latency, the standardised form
is Low-Latency HLS: the server holds a playlist request open until the next
segment exists (`_HLS_msn` blocking reload) and advertises partial segments
before they close. That removes polling delay entirely rather than shortening
it, and it is a real specification with CloudFront support.

It is not proposed here because it multiplies request count and invigilation
does not need sub-second latency. But if latency ever becomes a hard
requirement, LL-HLS is where to spend the effort — not on a hand-rolled
synthesiser, and not on the two-stream handover in §6.

## 8. Making "no wait" true rather than merely fast

Three seconds is good; zero is better, and it comes from anticipating the click
rather than tuning the encoder.

**Warm on centre open, not on tile click.** An observer opening a centre is about
to watch its cameras. Start them at that moment — by the time the grid has
rendered, the streams are running and the first frame has already arrived. This
is the single most effective change available and it costs nothing extra,
because those are exactly the cameras that were about to be published anyway.

**Linger after the last viewer.** Keep a stream alive 30–60 s after nobody is
watching, so flicking away and back is instant. This is the 1.2× allowance in
the costing.

**Warm an observer's assigned centres at login.** They are assigned to a few, and
those are the ones they will open.

With warming the 3 seconds is absorbed before the user asks for anything and the
perceived wait is zero. Without it, 3 s is the floor.

## 9. Summary

| Setting | Value | Why |
|---|---|---|
| `hls_time` | **2 s** | No stall on start; ~6 s behind live |
| `hls_init_time` | **1 s** | 3.0 s to first frame instead of 6.4 s |
| Camera GOP | **1–2 s** | ffmpeg cuts at the first keyframe *past* the target, so the GOP quantises everything |
| `hls_list_size` | **4** | 8 s of window — enough to survive a hiccup, not enough to hold stale media |
| Publishing | **On demand**, warmed on centre open | Better experience *and* a twentieth of the cost |
| Retention | Window plus a little | The agent deletes as segments roll; DELETE is free |
