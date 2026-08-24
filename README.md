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
- **Agents reach the control plane directly, not through CloudFront.** SigV4
  signs the Host header and CloudFront rewrites it, so `apiInvokeUrl` is the
  API Gateway endpoint. Only browsers go through the CDN.
