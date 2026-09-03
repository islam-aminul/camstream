# Pending

What is known to be missing, unfinished, or deliberately deferred, as of
2026-08-30. Written down because none of it was recorded anywhere — no TODOs
in the source, no open issues — which meant it lived only in whoever last
worked on it.

Ordered by what would hurt first, not by effort.

## Operational

### Alarms reach nobody

Seven CloudWatch alarms exist — API 5xx, and Lambda errors for admin, device,
presence, session, streams and watch — and the SNS topic they publish to has
no subscriptions. Every one of them is currently OK, so nothing has been lost
yet, but a lambda failing at three in the morning would page nobody and the
first report would come from a customer looking at a black wall.

The subscription belongs in the CDK rather than clicked into the console, so
it survives a redeploy. An email endpoint needs confirming from the inbox once.

### No recording, and no playback

Live only. Segments expire from the live bucket after a day by lifecycle rule,
the console has no timeline, and there is no archive of any kind — the only
"archive" in the codebase is the installer zip.

"What happened at the gate at three in the morning last Tuesday" therefore has
no answer. For some buyers of a CCTV product that is the entire product, so
this is a scope decision that should be made deliberately rather than by
default.

### No password reset

There is no forgot-password flow in the console and none in the auth client. A
user who forgets theirs needs an administrator to reset it in Cognito by hand.
Tolerable at five users, not at five hundred, which is the number the console
was built for.

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

## Housekeeping

- **`gate-house-new` is a phantom agent.** Created during installer testing on
  2026-08-29, connected once, never ran a build. It appears in the Agents list
  as an agent that has never checked in.
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

The console was measured against ten thousand synthetic cameras, and the Linux
installer runs against real systemd in CI. But the live estate is one agent and
one camera. None of the following has been exercised against real hardware:

- more than one agent publishing at once
- more than one viewer on the same site
- a second premises with real cameras
- the macOS bundle, on any Mac
- anything near the 128-stream ceiling, or the hardware-pressure logic that is
  supposed to shed conversions before it is reached
