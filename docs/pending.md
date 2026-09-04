# Pending

What is known to be missing, unfinished, or deliberately deferred, as of
2026-09-03. Written down because none of it was recorded anywhere — no TODOs
in the source, no open issues — which meant it lived only in whoever last
worked on it.

Ordered by what would hurt first, not by effort.

## Operational

### Customers are never told anything

Alerting today is one SNS topic for the platform operator: the control plane is
broken, throttled, or hearing from nobody. Deliberately fleet-wide — one agent
going quiet is a site losing power, which is the customer's problem and not an
ops page at three in the morning.

But nothing tells the customer either. Their camera can be dark for a week and
the only way to find out is to open the console and look. For a CCTV product
that is arguably the feature: "your front gate stopped recording an hour ago"
is what somebody is paying for.

CloudWatch is the wrong instrument. Its alarms are fleet-wide aggregates, and
per-agent alarms would mean one alarm per agent — a thousand of them at the
shape this is built for, about $100 a month, created and destroyed as agents
come and go, by CloudFormation, which does not know the estate. The registry
does. Worse, SNS has no concept of a tenant, so routing per customer through
topics risks telling one customer about another's site, which is a disclosure
rather than noise.

What it actually is: a scheduled Lambda over the registry, which already holds
`connected`, `lastSeen` and per-camera `publishing`; recipients stored per
tenant and premises and managed in the console, so a customer configures their
own without a deploy; `notifiedAt` on the record so it tells you once rather
than every five minutes, and says so again when it recovers; delivery by SES.

SES rather than SNS because an SNS email subscription must be confirmed per
address, which is hopeless for customers. Cost is not the constraint — SES is
$0.10 per thousand — but **the account is in the SES sandbox**
(`ProductionAccessEnabled: false`, 200 a day, verified recipients only), so
nothing can be sent to a customer until production access is requested. That is
a support ticket, usually granted within a day, and worth raising early because
it is refused more often for accounts with no sending history.

### No password reset

There is no forgot-password flow in the console and none in the auth client. A
user who forgets theirs needs an administrator to reset it in Cognito by hand.
Tolerable at five users, not at five hundred, which is the number the console
was built for.

## Security

### The update package is not signed

An update instruction carries a presigned URL, and the agent's only check on it
is `isTrustedSource`: HTTPS, host ending `.amazonaws.com`, containing `s3`.
That is the shape of a URL, not proof it is ours. The real protection is that
the instruction arrives over MQTT authenticated by the device certificate,
which is adequate for "replace this jar" and thin for anything wider.

It matters more since the update endpoint gained a `format` parameter, and it
is a precondition for the manifest design below — that one lets a package
describe privileged steps, and without signing, "who can produce a package"
is answered by "anyone who can produce a plausible URL".

Needs a decision before it is code: where the private key lives (a KMS
asymmetric key signed at publish time, with the public key baked into the
agent, is the obvious answer), and it needs its own two-phase rollout per
`updating.md` — agents must be able to verify before anything is published
signed-only, or updates stop working with no way to fix them remotely.

### The Windows agent runs as SYSTEM

On Linux the agent is an unprivileged user under `ProtectSystem=strict` and
cannot write its own program; a root-run `ExecStartPre` installs staged
updates. On Windows the service is LocalSystem and `C:\Program Files\CamStream`
grants SYSTEM FullControl, so a compromised agent can rewrite its own jar, its
launcher and its service definition.

WinSW supports running under a dedicated `serviceaccount`. Worth doing, but as
its own change: the account needs the state directory, outbound network and the
right to spawn ffmpeg, and getting it wrong leaves an install that will not
start.

## Product

### First view of an idle camera takes 30–60 seconds

Demand has to reach the watch lambda, the lambda publishes desired state, the
agent starts ffmpeg, and enough four-second segments have to land before a
playlist means anything. The tile does say it is starting, and the delay is
inherent to starting streams on demand rather than running them constantly —
which is what makes an idle estate nearly free. But it is the first impression
every time, and worth a decision: accept it, warm a camera on hover, or keep
recently-watched cameras alive for a few minutes.

### Expanding a tile does not reduce the bill

The rest of the wall keeps its demand while one camera is full size, so
zooming costs more rather than less. Deliberate — you are one click from the
wall, and restarting an agent's ffmpeg for a few seconds of zoom costs more
than it saves — but it is a choice worth revisiting if anyone leaves a camera
expanded for long periods.

### Rail levels are hidden rather than disabled

The request was to disable irrelevant selection levels; they are hidden
instead, on the grounds that a disabled dropdown still invites a click and
then refuses. Nothing is cleared and the value still applies on pages that
read it. Flagged in case the other behaviour is preferred.

## Deferred by decision

### Update steps still live in the agent, not in the package

The agent decides how an update is applied, so a change to that logic only
takes effect on the *next* update and a bug in it cannot be fixed remotely at
all. Two bugs of exactly that shape were found on the first Linux install.

The proposal is a declarative manifest in the package interpreted by the
already-existing privileged pre-start step, with a fixed vocabulary rather than
an arbitrary script — a script would hand a compromised agent root on Linux and
undo the privilege separation deliberately built there.

Deliberately not built yet. It is an evolvability improvement, not a security
one, and it should come after signing: the vocabulary bounds what a package can
express, but only a signature bounds who can produce one. The cheaper half of
the same problem — two container formats, which is what actually caused the
bug — has been done, and `updating.md` records the migration rule that makes a
future format change survivable.

## Housekeeping

- **`rpi4b` holds the only camera.** The Windows `gate-house` agent has zero
  cameras; both run the same build. Move the camera back if the Pi is switched
  off — the console's Cameras page does it in one dialog.
- **`gate-house-new` is a phantom agent.** Created during installer testing on
  2026-08-29, connected once, never ran a build. It appears in the Agents list
  as an agent that has never checked in, and it is offered as a destination in
  the move dialog where it can only ever be refused.
- **Three seeded agents at North West Depot** — `edge-001`, `edge-002`,
  `loading-dock` — are fixtures, not real machines. Their hundred seeded
  cameras were removed on 2026-08-30; the agents were left because only the
  cameras were asked for.
- **The maintainer's email address is in the git history**, across the commits
  that built this. Rewriting history was deliberately not done, and is the
  repository owner's call.
- **`out.log`'s timestamp is the OS locale's format** (`30-08-2026  0:05:47.66`)
  rather than the ISO-with-offset the agent's own log uses. cmd has no portable
  ISO clock and spawning PowerShell for a marker line would add a dependency to
  a launcher that has to be dependable.

## Unproven rather than unbuilt

A Raspberry Pi 4B (`rpi4b`, Ubuntu 26.04, aarch64) runs a second agent against
the same camera, which settled several open questions: the AWS CRT native loads
on aarch64, fleet provisioning works, discovery and streaming work, the
installer's dependency extraction, architecture detection and sudo re-exec all
behave, and remote update now works on both Windows and Linux — including a
format migration performed without touching either machine.

Still unexercised against real hardware:

- more than one agent *publishing* at once (the two exist, but ownership of the
  single camera moves between them rather than being held by both)
- more than one viewer on the same site
- a second premises with real cameras
- anything near the 128-stream ceiling, or the hardware-pressure logic that is
  supposed to shed conversions before it is reached

### A Pi's clock, and whether it can recover

A Pi has no clock battery, so every reboot leaves it at whatever the filesystem
last recorded — on rpi4b, thirty-nine days behind on 4 September and four and a
half months behind on 30 August.

Whether it recovers turns out to depend on how far back it lands. Ubuntu's
chrony is configured against NTS servers, whose key exchange runs over TLS, so
recovery needs a clock inside the server certificate's validity window. Thirty-
nine days back was still inside one and chrony corrected itself within minutes.
Four and a half months back was before the certificate was issued, the
handshake failed on "not yet valid", and the box was stuck until somebody set
the date by hand.

So it is not reliably self-healing, and the failure is silent: the box looks
up, answers ping, and serves SSH.

`fake-hwclock` is now installed on rpi4b, which closes the common case: it
saves the time on a timer and at shutdown and restores it at boot, so chrony
starts close enough to finish a handshake. Its timer ships as `OnCalendar=hourly`,
which is too coarse — a power cut then restores a clock up to an hour stale,
outside the roughly five minutes AWS will sign for, so the agent spends a
couple of minutes being refused before chrony steps it. Overridden to `*:0/5`
on rpi4b, which narrows it but cannot close it: the restored clock is stale by
the save interval *plus* the length of the outage, and an outage is unbounded.
Measured on a power cut with the five-minute timer in place — six minutes
behind, still outside the window, still refused. No save interval fixes that,
which is why the unit now orders itself after `time-sync.target` and the
installer enables `chrony-wait` to give that target meaning. Worth
baking into the installer if Pis become a supported target. Note that the package's own units
(`fake-hwclock-load`, `-save`, `-save.timer`) are what do the work — the
SysV-compatible `fake-hwclock.service` is masked deliberately, so trying to
enable that one fails and is meant to.

What that does not close is a board powered off for months: the restored
timestamp is then months old too. Every source Ubuntu configures carries
`nts`, so all of them depend on TLS and none can be reached from a badly
wrong clock. A plain, non-NTS pool removes that dependency, at the price of
accepting unauthenticated time as a last resort — chrony still prefers the
NTS sources, which are marked `prefer`. **Applied on rpi4b** (`pool
ntp.ubuntu.com iburst maxsources 4`, uncommented in `sources.d`) and
verified reaching stratum 2. Not in the installer, which is the pending part.

The ordering is deliberately soft — `Wants=`/`After=`, never `Requires=`.
`chrony-wait` gives up after three minutes, and on a site whose firewall
blocks NTP it always will. Under `Wants=` that is a three-minute delay;
under `Requires=` the agent never starts, and the site goes from late to
dark. A camera that starts with a wrong clock is worth more than one that
does not start. `infra/test/clock-ordering.test.ts` pins all of it, because
every line involved can be deleted without breaking a build, an install or
a test — the cost only appears at the next power cut.

The agent no longer *stays* broken either: a supervised task retries
configuration until it succeeds, and a skewed clock is named in the log
rather than appearing as a bare 403.

Worth doing before any customer runs one of these, because the symptom reaches
the console as "registered, but its agent has not reported it yet" — which
points at the camera and its credentials, and both are fine.
