# CamStream

Serverless, pay-as-you-go live CCTV streaming. On-premises agents publish HLS
straight to S3; CloudFront serves it to authenticated viewers. Nothing runs, and
nothing bills, while no one is watching.

**Live:** https://camstream.online

## How it fits together

```
IP cameras ──RTSP──> CamStreamAgent ──HLS/S3──> S3 ──> CloudFront ──> browser
                          ▲                                  │
                          └────── MQTT watch commands ────────┘
                                  (AWS IoT Core)          /api/*  ──> Lambda
```

The path a video frame takes contains no Lambda, no API Gateway and no media
server. Agents hold IoT-issued AWS credentials and write to S3 directly, so
per-segment cost is a single S3 PUT.

Viewers never see an S3 URL. CloudFront gates `/live/*` behind signed cookies
scoped to the caller's tenant, minted by `/api/session`.

## Cost model

Idle cost is a hosted zone ($0.50/month) plus rounding. Everything else is
driven by viewing:

| Driver | Cost |
|---|---|
| Segment uploads | 2 S3 PUTs per segment per active camera (~1/s at 2s segments) |
| Delivery | CloudFront egress, only while watched |
| Control plane | Lambda + DynamoDB on-demand; a few calls per viewer per minute |
| Storage | Effectively nil — segments expire after 1 day |

`segmentDurationMs` is the dial: 2s gives ~5s latency, 4s halves request cost
for roughly double the delay.

### Measured

A real CP Plus sub-stream at 640×360, h264, sampled while publishing:

| `segmentDurationMs` | actual segment | S3 PUTs | bandwidth | cost @ 8h/day |
|---|---|---|---|---|
| 2000 | 3.0s | 0.67/s | 9.3 KB/s | **$3.78/camera/month** |
| 6000 | 5.5s | 0.37/s | 10.0 KB/s | **$2.55/camera/month** |

Nothing at all while nobody is watching.

Requests dominate the bill roughly three to one over bandwidth, which is why
segment duration is the lever that matters: bandwidth is the same video either
way. Longer segments buy less than proportionally, though — going from 2s to 6s
saved a third, not two thirds.

Two caveats show up directly in that table. Actual segments run longer than
configured, because the agent stream-copies and can only cut on a keyframe: the
camera's GOP is the floor, whatever the setting says. And the measured ~80 kbps
is a twentieth of the 2048 kbps this camera advertises over ONVIF, which is why
the ABR ladder ignores declared bitrates that fail to discriminate.

### Transcoding, verified

A simulated H.265 camera served over RTSP, watched simultaneously by two
accounts declaring different codec support:

| Viewer declares | Control plane asks agent for | Published |
|---|---|---|
| `h264, hevc` | `variant: source` | `sub/` — hevc/Main, stream copy |
| `h264` only | `variant: h264` | `sub-h264/` — h264/High, transcoded |

Both renditions run at once off the same camera, and neither viewer pays for the
other's. A site whose viewers all support HEVC never starts an encoder.

The master playlist labels each rung with the codec it actually carries, so a
browser without HEVC selects the H.264 rung rather than rejecting both — rungs
differing only by codec are alternatives for different clients, not steps of a
bitrate ladder.

### Why fMP4 rather than MPEG-TS

Segments are fragmented MP4. MPEG-TS carries 188-byte packet framing that adds
roughly 3–7% to every byte for identical video, and hls.js transmuxes it back to
fMP4 in the browser regardless — so TS costs more in bandwidth and in client
CPU, and buys compatibility only with players this system does not target.

## Repository layout

| Path | What it is |
|---|---|
| `infra/` | AWS CDK (TypeScript) — three stacks, see below |
| `infra/lambda/` | Control plane: session, streams, watch, heartbeat |
| `agent/` | CamStreamAgent — Java 21, wraps ffmpeg |
| `web/` | React + Vite + hls.js player |
| `scripts/` | Bootstrap, deploy and device provisioning |
| `docs/licensing.md` | Commercial licensing audit — read before shipping |

## Deploying from scratch

Stacks must go up in this order; step 2 needs a human at the registrar.

```bash
./scripts/bootstrap-keys.sh                  # CloudFront signing keypair
cd infra && npm install
npx cdk bootstrap aws://<account>/ap-south-1 aws://<account>/us-east-1
npx cdk deploy CamStreamZone                 # 1. hosted zone
#    -> point the domain's nameservers at the four it prints, then wait
npx cdk deploy CamStreamCert                 # 2. ACM cert (us-east-1)
npx cdk deploy CamStreamApp                  # 3. everything else
cd .. && ./scripts/deploy-web.sh             # 4. the player
```

## Roles

| | superadmin | admin | operator | viewer |
|---|---|---|---|---|
| Act across tenants | ✓ | | | |
| Manage users and roles | ✓ | ✓ own tenant | | |
| Premises, agents, cameras | ✓ | ✓ | ✓ | |
| Set camera credentials | ✓ | ✓ | ✓ | |
| Watch streams | ✓ | ✓ | ✓ | ✓ |

Every admin endpoint checks two things independently: whether the role permits
the action at all, and whether the target premises is one the caller may act on.
Both, on listings as well as mutations — a viewer cannot enumerate the estate,
and an operator restricted to one site cannot store credentials, trigger scans
or remove cameras at another.

Roles are Cognito groups rather than token attributes, so revoking one takes
effect on the next token refresh instead of whenever a token happens to lapse.
Operators may set camera credentials because whoever installs a camera has its
password — splitting those makes every site visit a two-person job. Credentials
are write-only for every role; there is no endpoint that returns one.

Scoping applies to listings as well as playback. A viewer restricted to one site
does not see other sites' cameras in `/api/streams`, and cannot cause their
agents to start publishing through `/api/watch` — otherwise a restriction that
blocked viewing would still leak the shape of the estate, and still spend money
at sites the account is not entitled to.

A user restricted to exactly one premises receives a cookie scoped to that
site's prefix. Restricting to several still grants the whole tenant, because a
CloudFront policy carries a single wildcard — the admin console says so rather
than implying otherwise.

Verified against the deployed system: a viewer scoped to `acme-hq` is issued
`https://camstream.online/live/demo--acme-hq--*` and receives 200 for that
site's streams and **403** for another premises in the same tenant, while an
unscoped account gets `live/demo--*` and reaches both. This is the reason
premises is in the thing name and the S3 key rather than being an attribute.

## Installing an agent

`packaging/build-dist.sh` produces a bundle per platform under `dist/`. Each
carries the jar, the installer, a config template, and the licence notices.

```bash
./packaging/build-dist.sh                 # build only
CAMSTREAM_PUBLISH=1 ./packaging/build-dist.sh   # and publish for installers
```

Publishing uploads the bundles to a `downloads/` prefix that no CloudFront
behaviour maps to, so they are reachable only through a presigned link the
console generates.

The normal path is zero-touch: create a premises, enrol an agent, and download
its installer from the admin console. That download is a few kilobytes — it
carries the identity inline and a presigned link to the generic bundle, which
stays identical for every customer and cached. It contains a single-use
enrollment token, so treat it as a secret until it has been run.

```bash
sudo ./install-demo--acme-hq--gate-01.sh     # fetches the bundle and enrols
```

On first boot the agent exchanges the shared claim certificate and its token for
its own certificate. Nothing is copied by hand, and no device private key ever
passes through the console or a browser.

To install from a pre-built bundle instead:

```bash
tar -xzf camstream-agent-0.1.0-linux.tar.gz
sudo ./install.sh --identity identity.json   # journalctl -u camstream-agent -f
sudo ./install.sh /path/to/agent.yaml        # already-provisioned device
```

Runs as an unprivileged `camstream` user under a hardened unit —
`ProtectSystem=strict`, `NoNewPrivileges`, writable only in its own state
directory. Restarts forever, because an unattended box has nobody to run
`systemctl reset-failed`.

**Windows**: `install.ps1` from an elevated prompt. Java cannot answer the
Service Control Manager itself, so one of two mechanisms is used — WinSW (MIT,
fetched at install time, a real service with log rolling) or, with
`-UseScheduledTask`, a boot-time scheduled task running as SYSTEM. The task
route needs no external dependency but is not visible in `services.msc`.

**macOS**: a launchd plist is provided for development; it is not a supported
production target.

### Architectures

The jar itself is architecture-independent: AWS CRT — the only native
dependency — bundles a library for every platform and selects one at runtime
from `os.arch` and whether the host uses glibc or musl. One bundle per operating
system is therefore enough, and the three differ only in their installer
scripts.

| | x86_64 | arm64 | armv7 / armv6 |
|---|---|---|---|
| Linux (glibc) | ✅ | ✅ | ✅ |
| Linux (musl, e.g. Alpine) | ✅ | ✅ | ✅ armv7 |
| macOS | ✅ | ✅ Apple Silicon |  |
| Windows | ✅ | ❌ **no native published** | |

Windows on ARM has no AWS CRT build. Install an **x64 JRE** instead — Windows 11
runs it under emulation and the agent works normally. The installer checks the
JVM's architecture rather than the machine's and refuses with that instruction,
because the failure would otherwise be an `UnsatisfiedLinkError` at first start.

Hardware encoders are the part that genuinely is not portable, since they follow
the silicon: `vaapi`/`qsv`/`amf` are x86_64, `v4l2m2m` is ARM SoCs such as the
Raspberry Pi, `nvenc` is NVIDIA on either, and `videotoolbox` is macOS. Nothing
breaks without them — the agent stream-copies by default and only needs an
encoder when a viewer cannot decode a camera's codec.

Reinstalling upgrades the jar and restarts the service, leaving configuration
and device identity alone. `uninstall.sh --purge` / `uninstall.ps1 -Purge`
removes those too — which destroys the credential key, so camera credentials
must then be re-entered.

## Adding a site

```bash
./scripts/provision-device.sh <tenantId> <deviceId> "Site name"
# edit devices/<tenant>--<device>/agent.yaml with the camera RTSP URLs
java -jar agent/target/camstream-agent.jar devices/<tenant>--<device>/agent.yaml
```

Identifiers are `[a-z0-9-]`, 3–32 chars, and may not contain `--` — that
sequence separates tenant from device inside the IoT thing name, and the
CloudFront cookie policy relies on the boundary being unambiguous.

## Testing without hardware

`scripts/simulate-camera.sh` stands up a fake camera: ffmpeg generates clips with
keyframes every 2s, and VLC serves them over RTSP on two ports, one per profile.

```bash
./scripts/simulate-camera.sh start     # rtsp://127.0.0.1:8554/sub, :8555/main
# paste the camera block it prints into devices/<thing>/agent.yaml
java -jar agent/target/camstream-agent.jar devices/<thing>/agent.yaml
./scripts/simulate-camera.sh stop
```

VLC 3's RTSP server speaks UDP only, so the simulated camera needs
`rtspTransport: udp`. Real cameras should stay on the `tcp` default.

## Camera discovery

Agents scan their own LAN and report what they find; an administrator decides
what becomes a camera. Two passes, because neither alone is sufficient:

1. **ONVIF WS-Discovery** — a multicast probe. Fast, needs no credentials, and
   returns the device's real service URL. Cheaper cameras ignore it.
2. **TCP sweep** of the agent's own subnets for ONVIF and RTSP ports. The range
   comes from each interface's netmask — if the site runs a /16, the cameras
   are somewhere in that /16. `discoveryMaxHosts` caps it if needed; the only
   built-in limit refuses to enumerate more than 65536 addresses from a single
   misconfigured interface.
   Cameras frequently sit on their own VLAN, in which case the interface
   netmask finds nothing — `discoveryNetworks` takes additional CIDRs to sweep.
3. **RTSP path probing** for cameras with no usable ONVIF media service, which
   is a large share of installed CCTV. Known vendor paths (Hikvision, Dahua,
   Axis, Reolink, Uniview and generic firmware) are tried and confirmed with
   `ffprobe` — not by the DESCRIBE status code, since many devices answer 200
   on a path carrying no media. Override with `rtspPaths`.

Each candidate is interrogated over ONVIF — both Media1 and Media2, which are
not compatible: Media2 renames the encoder element and returns profiles with an
empty configuration unless a `Type` is requested. Every stream is then confirmed
with `ffprobe`. ONVIF's advertised
encoding is regularly wrong, and the discrepancy is routine rather than
theoretical: a CP Plus camera used for testing advertises 25fps over ONVIF and
delivers 20. The codec decides whether viewers need a transcode, so the stream
is asked rather than believed.

### Camera identity

An IP address is a DHCP lease and will move. Identity is therefore taken from
the first of these that exists:

| Source | Survives |
|---|---|
| ONVIF serial number → `sn-…` | re-addressing and NIC replacement |
| MAC from the ARP cache → `mac-…` | re-addressing |
| IP address → `ip-…` | nothing |

The fallback is recorded as `identityStable: false` rather than hidden, so the
admin UI can warn before someone approves a camera whose identity will change at
the next lease renewal.

## Camera credentials

RTSP credentials are keys to the customer's premises, and the cloud never holds
a readable copy.

On first run an agent generates an RSA keypair, separate from its IoT
certificate, and publishes only the public half via heartbeat. The admin UI
encrypts a credential in the browser with WebCrypto RSA-OAEP against that
device's key; the control plane stores and relays opaque ciphertext; the agent
decrypts it with a private key that never leaves the edge box.

| Cloud may hold | Cloud never holds |
|---|---|
| IP, MAC, manufacturer, model, firmware | username, password |
| ONVIF/RTSP ports, media profiles, codec | RTSP URLs, which embed credentials |
| auth state: needs-credentials / authenticated | anything decryptable by the operator |

`DiscoveredCamera.redacted()` enforces the right-hand column, dropping the
stream URLs before anything is reported upward.

Everything in the left-hand column is bounded on arrival. A camera's ONVIF
response is attacker-controlled input on the customer's network, and the agent
relays it verbatim — so manufacturer, model, MAC, address and profile fields are
length-capped, type-checked and stripped of control characters at the control
plane. Unbounded, one device could push a record past DynamoDB's 400KB item
limit and make the console unreadable for everyone.

Two consequences, both deliberate: **there is no credential recovery** — replace
an agent and the credentials are re-entered — and a bug in the admin UI cannot
leak them, because plaintext exists only in the admin's browser tab and on the
edge box.

## Multiple agents on one premises

A large site needs several agents, and their scan ranges will overlap. Discovered
cameras are therefore keyed by the camera's **own identity**, not by the agent
that found it, so one camera seen by three agents is one record listing three
sightings — not three records to approve and pay for separately.

Approval assigns exactly one agent as owner. Only that agent publishes the
camera; the others simply know it exists. The API refuses an assignment to an
agent that cannot reach the camera, since that would produce a stream that never
starts with nothing to explain why.

## Administration

`/admin`, available to members of the Cognito `admin` group, within their own
tenant only.

| Tab | What it does |
|---|---|
| Cameras | Approve discovered cameras, assign an owning agent, set credentials |
| Agents | Health, version, last seen, whether an encryption key has been published |
| Users | Invite viewers or administrators, remove accounts |

Credentials are encrypted in the administrator's browser before they are sent,
against the owning agent's published key. There is no endpoint that returns a
credential, and no "reveal" control, because the control plane holds no key that
could open one. Credentials may be per-camera or site-wide — cameras on one site
frequently do not share a password.

## Adaptive bitrate

The ladder is the camera's own sub and main profiles, so it costs nothing to
generate — still pure stream copy. Where a camera declares bitrates that fail to
distinguish its renditions — a real one reported 2048 kbps for both its 1080p
and its 640x360 profile — the figures are replaced with estimates from
resolution, since equal `BANDWIDTH` values leave a player unable to choose. A `master.m3u8` appears beside the renditions
whenever a camera is publishing more than one, which in practice means a viewer
has opened it. That is deliberate: the detail view is the only place a stream is
large enough to outrun a connection, and advertising a rendition that is not
being published would make the player switch up into a 404.

## Adding a viewer

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> --username <email> \
  --user-attributes Name=email,Value=<email> Name=email_verified,Value=true \
                    Name=custom:tenantId,Value=<tenantId>
```

A user sees every camera belonging to their tenant, and no others.

## Things worth knowing

- **Latency is ~5s**, not sub-second. Sub-second needs blocking playlist
  reloads, which S3 cannot do. Genuine sub-second would mean WebRTC.
- **One session per account.** Signing in anywhere invalidates the previous
  one, and every authenticated route enforces it — not only those that carry a
  session id. The check compares Cognito's `origin_jti`, which survives a token
  refresh but changes on a fresh sign-in, so a displaced device loses API access
  immediately despite holding a valid unexpired token. Media playback is the one
  exception: CloudFront has no cookie revocation list, so a displaced viewer can
  still fetch segments until its cookies lapse, which is why that TTL is five
  minutes rather than hours.
- **One main stream per viewer.** Grid view uses camera sub-streams; opening a
  camera switches that one to its main stream.
- **FFmpeg must be an LGPL build.** Run `scripts/check-ffmpeg-license.sh`.
- **Camera GOP must be no longer than `segmentDurationMs`.** The agent
  stream-copies, so it can only cut a segment on a keyframe. A camera set to a
  4s GOP will silently produce 4s segments and roughly double the latency,
  whatever the config says.
- **The playlist is written by the agent, not relayed from ffmpeg.** ffmpeg
  numbers segments per process, so every restart would reset the media sequence
  and append `EXT-X-ENDLIST` — telling a viewer the stream had ended. The agent
  keeps a sequence that only increases and marks a real discontinuity where the
  encoder actually restarted.
- **Everything long-running is supervised.** Publishing, heartbeats and
  discovery are registered with `Supervisor` rather than scheduled directly: a
  bare `ScheduledExecutorService` silently cancels a periodic task that throws,
  which on an unattended box means it stops working and nobody notices.
- **Agents reach the control plane directly, not through CloudFront.** SigV4
  signs the Host header and CloudFront rewrites it, so `apiInvokeUrl` is the
  API Gateway endpoint. Only browsers go through the CDN.
