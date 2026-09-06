# Segments, playlists, and what a viewer sees

One-second first segment, ten seconds thereafter. This is what that actually
produces on disk, in the playlist, and on screen.

## 1. What ffmpeg does with the two settings

```
-hls_time 10          steady-state target
-hls_init_time 1      target for the first segment only
-hls_list_size 4      segments kept in the playlist
-hls_segment_type fmp4
```

**ffmpeg cuts at the first keyframe at or after the target**, never before. That
one sentence explains every number below, and it has two consequences that
surprise people.

**Segment length is quantised to the camera's GOP.** A target of 10 s against a
2-second GOP gives exactly 10 s, five groups of pictures. Against a 3.274-second
GOP it gives **13.1 s** — four GOPs — because there is no keyframe at 10 s and
ffmpeg waits for the next one. A 31% overshoot nobody asked for.

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

| Camera GOP | Target 10 s | Actual segment | Overshoot |
|---|---|---|---|
| 1 s | 10 s | 10.0 s | — |
| **2 s** | 10 s | **10.0 s** | — |
| 2.5 s | 10 s | 10.0 s | — |
| 3.274 s | 10 s | 13.1 s | +31% |
| 4 s | 10 s | 12.0 s | +20% |

**Recommend a 2-second GOP on every camera.** It divides 10 cleanly, it keeps
the first segment short (one GOP = 2 s), and it bounds how far a viewer can be
from a keyframe when they join. Cameras that cannot be configured will overshoot
and that is survivable — but it is worth a configuration sweep, because it costs
nothing and makes both latency and request count predictable.

## 2. Segment sizes on disk

At the measured ~110 kbps sub-stream:

| Object | Duration | Size | Written |
|---|---|---|---|
| `<run>_init.mp4` | — | ~1 KB | Once per stream start |
| First segment | ~2 s (one GOP) | ~27 KB | Once |
| Steady segment | 10 s | ~137 KB | Every 10 s |
| `index.m3u8` | — | ~400 B | Every segment |

The init segment is fMP4's `moov` box — codec parameters and nothing else. It is
fetched once by each viewer and referenced by `EXT-X-MAP`. It must never be
deleted while the stream is live; deleting it breaks every player mid-stream,
which is a specific bug this project has already had and fixed.

Per camera-hour: 360 media segments + 360 playlist rewrites = **720 PUT**, and
~49.5 MB.

## 3. What the playlist looks like, minute by minute

**At t = 2 s**, the first segment has just been written:

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

One segment, and a viewer can start on it. `TARGETDURATION` is 2 because that is
the longest segment so far.

**At t = 12 s**, the first full segment lands and `TARGETDURATION` rises to 10:

```
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.000,   a1b2_000000.m4s
#EXTINF:10.000,  a1b2_000001.m4s
```

RFC 8216 says a server should not change `TARGETDURATION` within a playlist.
ffmpeg does, players tolerate it, and Apple's `mediastreamvalidator` will flag
it. Worth knowing before someone runs a conformance check and reports a defect.

**At t = 52 s**, steady state with a four-segment window:

```
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:10.000,  a1b2_000001.m4s
#EXTINF:10.000,  a1b2_000002.m4s
#EXTINF:10.000,  a1b2_000003.m4s
#EXTINF:10.000,  a1b2_000004.m4s
```

The short first segment has rolled out. `MEDIA-SEQUENCE` counts what has been
dropped, which is how a player detects it fell behind.

The window holds 40 s of media. The agent deletes each segment as it leaves the
window, so the object store holds roughly the window plus a little — not the
2-minute sweep the current platform runs.

## 4. What a viewer actually experiences

This is the part that decides whether the settings are right, and it splits into
two cases that behave completely differently.

### Case A — the viewer who starts the stream

Their click starts ffmpeg. The playlist has one segment, so there is nothing to
buffer and the player begins on it:

```
  0.0 s   ffmpeg starts, connects to the camera over RTSP
  ~1.5 s  first keyframe arrives
  ~2.0 s  first segment written and uploaded          <- 27 KB
  ~3.0 s  player has the playlist, init and segment; picture appears
```

Measured on this project, three runs, 2-second-GOP camera: **3.0 s to first
frame**. Without `hls_init_time` the same stream took **6.4 s**, because the
player waited for a full segment.

**This is the only case where the short first segment matters**, and it is the
whole reason the setting exists.

### Case B — the viewer who joins a stream already running

They get the steady-state playlist, and here HLS has a rule that dominates
everything: a player **should not start closer than three target durations from
the end of the playlist** (RFC 8216 §6.3.3). It needs segments in hand to
survive a network hiccup.

```
  live edge          ─────────────────────────────────────►  now
  player starts here  ◄── 3 × TARGETDURATION ──┤
```

| Target | Player starts | Behind live |
|---|---|---|
| 4 s | 3 segments back | ~12 s |
| **10 s** | 3 segments back | **~30 s** |
| 15 s | 3 segments back | ~45 s |
| 20 s | 3 segments back | ~60 s |

**The short first segment does nothing for case B.** It rolled out of the window
30 seconds ago. A joining viewer's latency is set entirely by `TARGETDURATION`.

### Which case matters depends on the publishing model

- **Publishing on demand** — every viewer is case A, because their click starts
  the stream. First frame ~3 s, and the 10-second steady state costs them
  nothing on start-up.
- **Publishing continuously** — every viewer is case B. The stream has been
  running through the whole margin, so `hls_init_time` is irrelevant and the
  observer is ~30 s behind live.

That is the sharpest argument in this document for publishing on demand, and it
is not primarily a cost argument. **Continuous publishing gives a worse viewer
experience than on-demand**, because it forces every viewer into the 3-segment
live-edge rule while on-demand lets the first viewer start on a 2-second
segment.

The margin hours exist to avoid a start-up wait, and they buy a 30-second
standing delay instead.

## 5. Tuning the live edge, if 30 s is too far behind

Three levers, in order of preference:

**Shorten the target.** Linear, predictable, and costs requests: 4 s gives ~12 s
behind live at 2.5× the PUT cost. `20-cost.md` §3.3 prices each step.

**Lower the player's segment count.** `hls.js` exposes `liveSyncDurationCount`,
default 3. Setting it to 2 takes a 10-second stream from ~30 s to ~20 s behind,
free, at the cost of less buffer against a hiccup. Worth testing on the worst
centre uplink before adopting.

**Low-Latency HLS.** Partial segments published before the full segment closes,
getting to two or three seconds behind live. It multiplies request count
substantially and needs both player and CDN support. Not recommended here —
invigilation does not need two seconds, and the request count is already 92% of
the bill.

## 6. Recommendation

| Setting | Value | Why |
|---|---|---|
| `hls_init_time` | **1 s** | 3.0 s to first frame instead of 6.4 s, for whoever starts the stream |
| `hls_time` | **10 s** | Your existing choice; 2.5× cheaper than 4 s and no worse for a viewer who starts the stream |
| Camera GOP | **2 s** | Divides 10 exactly; no overshoot; short first segment |
| `hls_list_size` | **4** | 40 s of window — enough for the 3-segment rule with one spare |
| Retention | **window + margin**, not 2 minutes | The agent deletes as segments leave the window; DELETE is free |

And one open question that changes the shape of everything: **if a viewer's
first frame arrives in 3 seconds, are margin hours still needed?** If not,
publishing becomes demand-driven, the observer experience gets *better* rather
than worse, and the publishing bill drops by roughly an order of magnitude.
