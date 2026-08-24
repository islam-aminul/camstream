# CamStream licensing position

CamStream is intended to be distributed and operated commercially. This
document records what the product depends on, under what terms, and the two
decisions taken specifically to keep that possible.

Last verified: 2026-08-24, against the dependency trees actually resolved by
`mvn dependency:list` and the installed `node_modules`. Re-run both after any
dependency change — this file is an audit record, not a guess.

## Summary

| Component | Licence | Notes |
|---|---|---|
| CamStreamAgent deps (39 jars) | Apache-2.0, MIT, MIT-0 | AWS SDK, AWS IoT Device SDK v2, aws-crt, Jackson, SnakeYAML, SLF4J, reactive-streams, eventstream |
| Infra + web deps (61 packages) | Apache-2.0, MIT, BSD-3-Clause, ISC, 0BSD | No copyleft present |
| JUnit 5 | EPL-2.0 | Test scope only — never distributed |
| FFmpeg | **LGPL-2.1+ required** | See below; the distro build is GPL and must not be shipped |
| H.264 / H.265 patents | Not exercised | See below |

No GPL, AGPL, SSPL, BUSL or non-commercial licence appears in any runtime
dependency.

`aws-crt` ships prebuilt native libraries inside its jar. It is Apache-2.0 and
redistributable, but it is platform-specific: an agent distribution must either
bundle the jar for each target platform or resolve it at install time.

## Decision 1 — the agent never transcodes

Every camera profile is relayed with `-c copy`. Nothing is re-encoded.

This is a licensing decision before it is a performance one, and it removes two
separate problems at once:

**GPL.** An FFmpeg build only becomes GPL because of what is compiled into it —
`libx264` and `libx265` are GPL, and enabling them forces `--enable-gpl` on the
whole binary. Stream copying needs no encoder, so CamStream requires an
FFmpeg configured **without** `--enable-gpl`, `--enable-nonfree` or any GPL
codec library. Such a build is LGPL-2.1+, and since the agent invokes it as a
separate process over a pipe — never linking to it — the agent itself carries no
copyleft obligation.

> The FFmpeg shipped by Debian/Ubuntu **is** GPL (`--enable-gpl`, with
> `libx264.so` and `libx265.so` linked in). It is fine for local development.
> It must not be bundled into a commercial distribution of the agent.
> Run `scripts/check-ffmpeg-license.sh` to verify a target machine's build.

Audio is discarded entirely (`-an`), which removes AAC from the picture too.

**Patents.** H.264 and H.265 are covered by patent pools (Via LA, Access
Advance) whose licences attach to *encoders and decoders*. CamStream implements
neither. The camera encodes — its manufacturer licensed that. The viewer's
browser decodes — Google, Apple, Microsoft and Mozilla licensed that. CamStream
only moves already-encoded bytes between the two and never inspects a frame.

## Transcoding, when it is unavoidable

Some cameras only emit H.265, which Firefox and older Chrome cannot decode. The
agent can transcode to H.264 for exactly those viewers — without reintroducing
copyleft, because it never uses libx264.

`libx264` and `libx265` are GPL and force `--enable-gpl` onto the whole FFmpeg
binary. The *hardware* encoders do not:

| Profile | Encoder | Platform | Licence |
|---|---|---|---|
| `vaapi` | `h264_vaapi` | Linux, Intel/AMD iGPU | LGPL |
| `nvenc` | `h264_nvenc` | Linux/Windows, NVIDIA | LGPL |
| `v4l2m2m` | `h264_v4l2m2m` | Raspberry Pi, ARM SoCs | LGPL |
| `qsv` | `h264_qsv` | Windows, Intel Quick Sync | LGPL |
| `amf` | `h264_amf` | Windows, AMD | LGPL |

`libx264` is deliberately absent from the profile list. An operator who wants it
must express it through the `custom` profile and supply their own GPL FFmpeg —
moving the obligation to their deployment, never to a CamStream distribution.

The AVC *patent* position is separate from the copyleft one and does not
disappear when transcoding: encoding H.264 exercises claims that stream-copying
does not. Hardware encoders run on silicon whose vendor licensed the encoder
block, which is the usual basis for relying on it — confirm with counsel before
enabling transcode in a sold product.

### A dependency to avoid

`org.bytedeco:ffmpeg` (JavaCV) bundles a prebuilt FFmpeg. Its build script
enables `--enable-gpl --enable-libx264 --enable-libx265 --enable-version3`, so
the shipped native binary is GPL-3 even though the Java wrapper is Apache-2.0.
Anything reusing JavaCV for media work inherits that. CamStream invokes an
external FFmpeg instead, which is why `ffmpegPath` is configurable.

## Decision 2 — dynamic linking and attribution for FFmpeg

Because FFmpeg is LGPL and invoked out-of-process, the obligations are limited
to attribution and to not restricting the user's ability to replace it:

- Ship FFmpeg as a separate executable, never statically linked into the agent.
- Do not vendor a modified FFmpeg. If one is ever modified, publish the changes.
- Include the FFmpeg licence text and copyright notice in the distribution.
- Keep `ffmpegPath` configurable, as it already is, so an operator can
  substitute their own build.

## Attribution obligations

Apache-2.0 requires the licence text and any `NOTICE` content to travel with a
distribution. Before the first commercial release, generate and ship a combined
notice file:

```bash
# Java side
cd agent && mvn license:aggregate-add-third-party

# JS side
npx license-checker --production --summary
```

MIT, ISC, BSD-3-Clause and 0BSD require only that the copyright notice be
retained, which the generated file covers.

## What still needs a decision before selling

- **AWS customer agreement** — operating on the customer's own AWS account
  versus reselling capacity through yours changes who owns the data-processing
  relationship.
- **Camera credentials** — RTSP URLs embed usernames and passwords. They live in
  the agent's config file on the customer's premises and are never transmitted
  to AWS. Keep it that way; it keeps CamStream out of scope as a processor of
  those credentials.
- **Recording** — the current design purges segments within a day and stores no
  archive. Adding retention makes CamStream a processor of personal data under
  Indian DPDP and, for any EU customer, GDPR.
