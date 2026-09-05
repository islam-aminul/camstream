# Pending

What is known to be missing, unfinished, or deliberately deferred, as of
2026-09-05. Written down because none of it was recorded anywhere — no TODOs
in the source, no open issues — which meant it lived only in whoever last
worked on it.

Kept honest by deleting from it. An entry that has been fixed is removed rather
than annotated, unless what remains is genuinely different from what was
described; a backlog that only grows stops being read.

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

### ~~The update package is not signed~~ — done

**Closed on 2026-09-05.** Bundles are signed at publish time with a KMS
asymmetric key (`ECC_NIST_P256` / `ECDSA_SHA_256`), the signature travels in the
existing update instruction as S3 object metadata, and the agent verifies it
against a public key baked into the jar *before* the archive is opened. Since
0.1.7 an unsigned package is refused rather than accepted.

Both halves of the rollout `updating.md` demands are now shipped: 0.1.1 could
verify but did not insist, 0.1.7 insists. The order mattered — the updater that
applies an update is always the old one, so the demanding half could not go
first without stranding the fleet.

What this bought: an attacker who can cause an update instruction to be issued
still cannot make an agent run their code, because they cannot produce a
signature. Before it, they could.

What it did not: `kms:Sign` on the release key is now the whole trust boundary
for what the fleet will run. It should be held by the release path and nothing
else, and it is worth an alarm on its use. The design is in `signing.md`.

One operational consequence, recorded because it will look like a bug the first
time somebody hits it: **0.1.0 can no longer be installed remotely.** It is the
one bundle in the downloads prefix published before signing existed, and every
agent will now refuse it. Rolling back that far needs a manual install, which is
the correct outcome and not worth fixing.

### The Windows agent can still replace its own jar

On Linux the agent is an unprivileged user under `ProtectSystem=strict` and
cannot write its own program; a root-run `ExecStartPre` installs staged
updates. Windows had no equivalent — the service was LocalSystem, with
FullControl over its own directory.

Since 2026-09-05 it runs under a virtual account (`NT SERVICE\camstream-agent`)
instead: the Service Control Manager creates it, it has its own SID, and there
is no password to store or rotate. Both live agents are on it, and remote
update has been exercised under it.

What remains is deliberate. The account keeps write access to the install
directory, because a staged update is applied by the launcher in the service's
own identity, and WinSW runs every hook as the service account — so a
low-privilege service cannot perform its own swap. A compromised agent can
therefore still replace its own jar. It can no longer touch the rest of the
machine, which was the larger exposure.

Closing it needs a second privileged component: a SYSTEM-run step ordered
before the service, which is the Windows analogue of `ExecStartPre=+`. That is
a bigger change than the account swap was, and worth weighing against package
signing — both answer the same question of who decides what the agent runs, and
signing is the one that also covers where the jar came from.

## Product

### First view of an idle camera takes about twelve seconds

Measured on 2026-09-05, three cold starts against the Windows agent and a real
CP Plus camera, from the watch instruction reaching MQTT:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| ffmpeg starting | 2.4s | — | — |
| first segment and playlist in S3 | 11.7s | 11.6s | 11.9s |
| three segments available | 19.6s | 17.0s | 17.1s |

The previously recorded figure was 30–60 seconds. That was taken while the
Windows agent was losing its MQTT subscriptions every 129 seconds, so an
instruction arriving in one of those gaps was dropped and the viewer waited for
a resend. Most of the complaint was that fault, not the design.

What remains divides cleanly. About 2.4 seconds is MQTT delivery and the agent
deciding what to do, which is not worth attacking. The other nine are ffmpeg
connecting over RTSP, waiting for a keyframe, and producing a segment — and a
four-second segment cannot exist before four seconds of video do.

So the lever is `segmentDurationMs`, already configurable per agent between 500
and 10000 and currently 4000. Halving it should take roughly two seconds off
the first frame and rather more off "three segments ready", at the cost of
twice the requests and twice the per-segment overhead. Nobody has measured the
trade, and the numbers above are the baseline to measure against.

These exclude the browser: a click has to reach the watch lambda before any of
this starts, and the player then fetches the playlist and buffers. Both are
small next to nine seconds, but it means a person sees something closer to
thirteen than to twelve.

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

- **`gate-house` holds the only camera.** `rpi4b` has zero; both run 0.1.1.
  Move it if the Windows machine is switched off — the console's Cameras page
  does it in one dialog.
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
format migration performed without touching either machine, and, on
2026-09-05, an update applied under the reduced-privilege Windows service
account.

Still unexercised against real hardware:

- more than one agent *publishing* at once (the two exist, but ownership of the
  single camera moves between them rather than being held by both)
- a Windows restart or update while a stream is running: every restart so far
  has been to an idle agent, and the launcher swaps the jar at exactly the
  moment nothing holds it open
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
