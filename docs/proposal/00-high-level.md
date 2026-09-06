# A serverless replacement for the examination CCTV livestream platform

## Who this is for

The people who decide whether the current platform is rebuilt, and what it
costs. It assumes you know the existing system and does not re-explain it
except where the contrast is the argument.

## What exists today, and what it costs to run

800+ centres, 1,500+ agents, 25,000+ cameras. Agents multipart-upload HLS to a
fleet of 50+ WildFly servers behind an ALB; segments land on 50+ EFS file
systems sharded by agent id; a group of Nginx servers reads those file systems
and serves a composed `.m3u8` to viewers. Relays short-poll to stay in sync.
Capacity is adjusted by hand against expected load.

It works. The objection is not that it is broken; it is where the money and the
risk sit.

**Every byte of video is handled by a Java application server.** A WildFly
instance receiving a multipart upload and writing it to NFS is doing a file
copy, and you are renting an application server per unit of copy throughput. The
work is real; paying for a JVM to do it is not.

**EFS is the most expensive place in AWS to put a video scratch file.** It is
priced for shared POSIX semantics that an HLS segment does not need — segments
are written once, read a few times, and deleted. Fifty of them, sharded by agent
id, is also a fixed map: a hot shard cannot borrow capacity from a cold one, and
rebalancing means moving agents.

**The read path goes through NFS.** Every segment a viewer fetches is an Nginx
read from EFS. There is no edge cache, so a nationwide exam means every viewer
in the country pulling from a handful of AZs in one region.

**Capacity is provisioned for the peak and paid for all year.** Exam days are a
small fraction of the calendar; the fleet is not. Manual adjustment is also the
kind of task where the failure mode is discovering the shortfall on the morning
it matters.

**Blast radius follows the shard map.** Losing one EFS loses that shard's
centres, and which centres those are is an accident of agent id.

**And the deletes cannot keep up.** A single-threaded `find` removing files
older than two minutes falls behind during peak, because EFS schedules deletes
below reads and you are asking it to sustain some two million unlinks an hour at
a national-exam peak, while it is also serving every viewer. That is not a
tuning problem. It is what a POSIX file system does when used as a high-churn
ring buffer, and it is the clearest signal in the current design that the
storage layer is the wrong shape for the workload.

## What is proposed

Delete the ingest tier and the read tier. Not replace them — delete them.

```
  today
    camera → agent → ALB → WildFly (50+) → EFS (50+) → Nginx (n) → viewer

  proposed
    camera → agent ─────────────────────────→ S3 → CloudFront → viewer
                  ↘ MQTT ── control plane (Lambda + DynamoDB)
```

The agent already holds the video. It can put the segment in object storage
itself, over the same HTTPS it currently uses to reach the ALB, if it is given
credentials scoped to its own prefix. Nothing in between adds anything except
cost and a component that can be down.

Three properties follow from that, and they are the whole proposal:

**There is no ingest fleet to size.** S3 has no capacity to provision, no shard
map, and no instance to patch. Upload throughput is whatever the agents can
push. A centre that suddenly matters is not a capacity planning question.

**There is no read fleet either.** CloudFront serves from S3 and terminates TLS
at the edge, close to the viewer. Authorisation is a signed cookie, checked at
the edge, so an unauthorised request is refused before it reaches anything you
pay for per request.

**Cost becomes proportional to use rather than to peak.** Roughly $65,000 a
year against an estimated $314,000, and $35,200 with one optimisation. Between
exams the platform costs approximately nothing. During a shift it costs the segments
actually written and the bytes actually watched. This is structural, not a
saving found by tuning.

**The delete problem stops existing.** There is no sweep. The agent removes its
own objects as the two-minute window rolls, S3 charges nothing at all for DELETE
requests, and there is no queue to fall behind on. A one-day lifecycle rule sits
underneath as a backstop for anything a crash orphaned. Across the whole estate
the resident two-minute window is about 33 GB at peak — the fifty file systems are
replaced by roughly a pound a year of object storage.

## How the agent is trusted without a shared secret

Each agent is provisioned with its own X.509 certificate and exchanges it, at
run time, for temporary AWS credentials through the AWS IoT credentials
provider. The role it receives is scoped by `${credentials-iot:ThingName}`, so
an agent can write only beneath its own prefix and cannot read anything.

This matters more than it sounds. It means:

- no long-lived key on 1,500 machines in 800 buildings you do not control
- a compromised agent can corrupt its own centre's video and nothing else
- revocation is deactivating one certificate, not rotating a shared secret
  across the estate
- every credential issue is an IAM decision with a CloudTrail record

The camera passwords never leave the site at all. The control plane stores them
encrypted with a key only the agent holds, relays the envelope, and cannot read
it. The RTSP URL — the thing that actually embeds a credential — is assembled
on-premises and exists nowhere else.

## How viewing works, given the integration owns the users

The integrating solution owns candidate-to-camera mapping (roll number to MAC),
premises and centre details, and the user accounts. That does not change. It
keeps owning them.

What changes is that its viewer page shows video served from CloudFront rather
than from Nginx, and the authorisation for that video is a short-lived signed
cookie minted after *its* login succeeds.

```
  user → integration console  (username/password, their IdP, their rules)
              │
              │ server-to-server: "this user may watch centre 4021"
              ▼
        our control plane  → one-time token
              │
              ▼
  browser → https://live.<domain>/session?t=…   (our domain, so we can set the cookie)
              │  sets CloudFront-Policy / -Signature / -Key-Pair-Id
              ▼
        player page → CloudFront → S3
```

The redirect is not decoration. A cookie can only be set by the domain that
serves the response, so the integration's backend cannot set a cookie on the
CloudFront domain; the browser has to touch our origin once. Everything before
that hop is server-to-server and carries no video.

Mapping data moves in batches, both directions, never one record at a time:
the integration pushes centres and MAC-to-camera mappings; we expose the same
data back for reconciliation. Details in `10-implementation.md`.

## What this does not solve

**It does not make cameras reliable.** Most incidents on a platform like this
are a camera that is off, a site with no uplink, or a recorder configured with
a codec nothing can decode. That is unchanged, and the honest gain is only that
the platform can say which of those it is.

**It does not remove the agent.** Something must sit at each centre, speak RTSP
to the cameras, and produce HLS. That component stays, and it is the part most
worth investing in.

**It replaces the agent, and that is the point.** The existing one needs
frequent restarts, leaks memory and sometimes does not run — it is the least
reliable part of the platform. The Java 21 agent runs every subsystem under a
supervisor that retries failures, a watchdog that detects a task which has hung
and dumps its threads, resource telemetry that sheds work before a machine is
exhausted, and signed remote update so a fix does not need a site visit. See
`10-implementation.md` §2.1. Cost is the headline; this is the part that decides
whether a centre is watchable on exam morning.

**The request cost is the whole bill, and it is worth knowing that up front.**
S3 `PUT` requests are **92%** of the projected cost — more than bandwidth,
storage and compute combined, and by a wide margin. Viewing is 6%. That is
counter-intuitive enough that it is the first thing to say in a design review,
because every instinct about video platforms says bandwidth dominates, and here
it does not.

It follows that the only optimisations worth discussing are on the write path,
and the largest of them is **segment length**. Keeping your 10 seconds rather
than adopting this project's 4-second default is worth $89,424 a year — more
than every other optimisation combined. Synthesising playlists at read time is
worth another 46%, and changes nothing an observer can see.

## Why this shape rather than MediaLive / IVS / a managed service

**AWS Elemental MediaLive / MediaPackage** are built for broadcast-grade
channels and are priced per running channel-hour. 25,000 channels is not a
realistic bill, and the features being paid for — ad insertion, redundancy
pipelines, format conversion — are not wanted here.

**Amazon IVS** is priced per hour of input and output stream and is aimed at
interactive broadcast. Same shape of problem at this camera count.

The reason a plain S3 + CloudFront design wins is that this workload does not
need transcoding. The cameras already emit H.264 in an HLS-compatible form; the
agent stream-copies it. No re-encode means no per-stream compute, and once
per-stream compute is gone the only costs left are requests, bytes and storage —
all of which are priced per unit rather than per provisioned hour.

That also avoids an H.264 encoder licence and a GPL FFmpeg build, because
nothing in the path encodes anything. It is worth knowing that is a deliberate
position and not an accident.

## Evidence this works

This is not a paper design. It is running, small, on a two-agent estate:
Windows and Raspberry Pi 4B, real cameras and a real NVR, remote update with
signed packages, on-demand publishing, CloudFront signed cookies, and a console
that manages the estate. The numbers used throughout `20-cost.md` — segment
sizes, upload throughput, start-up latency, keyframe intervals — are measured
from it rather than estimated.

What it has *not* proven is scale. Two agents is not 1,500, and the sections in
`10-implementation.md` marked **unproven at scale** say so explicitly. The
partitioning, the request rates and the CloudFront cookie model are the three
places where the small system's answers may not survive multiplication, and each
is called out with what to test.

## What to read next

| Document | Answers |
|---|---|
| `10-implementation.md` | What gets built, the data model, the integration API contract, the security model, and what is unproven at scale |
| `15-segments.md` | Segment sizes, the playlist as it evolves, and the two very different things a viewer experiences |
| `20-cost.md` | What it costs across your actual exam calendar, with the workings exposed and every assumption labelled |
| `30-runbook.md` | The commands, in order, to stand the whole thing up by hand |
