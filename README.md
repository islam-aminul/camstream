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

## Installing an agent

`packaging/build-dist.sh` produces a bundle per platform under `dist/`. Each
carries the jar, the installer, a config template, and the licence notices.

```bash
./packaging/build-dist.sh
```

**Linux** (systemd, the primary target):

```bash
tar -xzf camstream-agent-0.1.0-linux.tar.gz
sudo ./install.sh /path/to/agent.yaml     # journalctl -u camstream-agent -f
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
3. **RTSP path probing** for cameras with no usable ONVIF media service, which
   is a large share of installed CCTV. Known vendor paths (Hikvision, Dahua,
   Axis, Reolink, Uniview and generic firmware) are tried and confirmed with
   `ffprobe` — not by the DESCRIBE status code, since many devices answer 200
   on a path carrying no media. Override with `rtspPaths`.

Each candidate is interrogated over ONVIF for its model, media profiles and
stream URIs, and every stream is confirmed with `ffprobe`. ONVIF's advertised
encoding is regularly wrong — a profile labelled H264 may deliver H.265 after a
firmware update — and the codec decides whether viewers need a transcode, so the
stream is asked rather than believed.

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
generate — still pure stream copy. A `master.m3u8` appears beside the renditions
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
  session. Because CloudFront has no cookie revocation list, the displaced
  session keeps working until its cookies lapse — hence the 5-minute TTL.
- **One main stream per viewer.** Grid view uses camera sub-streams; opening a
  camera switches that one to its main stream.
- **FFmpeg must be an LGPL build.** Run `scripts/check-ffmpeg-license.sh`.
- **Camera GOP must be no longer than `segmentDurationMs`.** The agent
  stream-copies, so it can only cut a segment on a keyframe. A camera set to a
  4s GOP will silently produce 4s segments and roughly double the latency,
  whatever the config says.
- **Everything long-running is supervised.** Publishing, heartbeats and
  discovery are registered with `Supervisor` rather than scheduled directly: a
  bare `ScheduledExecutorService` silently cancels a periodic task that throws,
  which on an unattended box means it stops working and nobody notices.
- **Agents reach the control plane directly, not through CloudFront.** SigV4
  signs the Host header and CloudFront rewrites it, so `apiInvokeUrl` is the
  API Gateway endpoint. Only browsers go through the CDN.
