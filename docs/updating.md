# Updating agents

Remote update exists so that upgrading an estate does not mean visiting every
machine. Everything here is about keeping that true.

## The one rule

**The updater that runs is always the old one.**

An agent applies an update using the code it is already running, so any change
to how updates work only takes effect on the *next* update — and a bug in that
code cannot be fixed remotely at all. That is not a wrinkle, it is the defining
constraint, and it has bitten twice:

- The updater opened every bundle as a zip while Linux shipped tarballs, so
  remote update worked on Windows only. No Linux agent could take the fix,
  because taking it required reading a tarball.
- The agent staged downloads beside the installed jar, which a hardened systemd
  unit cannot write. Same shape: the fix could not be delivered by the thing it
  was fixing.

Both were found the first time an agent ran on a Raspberry Pi, months after the
code was written and after a Windows-only fleet had reported no problem at all.

## Changing anything the old updater depends on

Two passes, in this order:

1. **Publish a build that understands both**, in the format the fleet can still
   read. Every agent takes this one using its existing code.
2. **Once every agent has it**, switch what is published.

The `format` parameter on `POST /api/admin/agents/{thing}/update` exists for
step 1 and nothing else. It names the container an agent should be pointed at,
defaulting to the current one:

```
POST /api/admin/agents/acme--hq--gate/update
{ "platform": "windows", "format": "zip" }
```

Without it, pass 1 is impossible and the only route is a person at a keyboard.

This was exercised on 2026-09-03 when the formats were unified. A Windows agent
running a zip-only updater was pointed at the transitional zip, took the build
that reads both, and then took a tarball on the next instruction — migrated
end to end without anyone touching the machine.

Producing the transitional artefact is a one-off each time: repackage the
current bundle into the old container and upload it beside the others. Delete
it once the fleet has moved.

## What is deliberately not in the agent

The step that installs a staged jar is **not** part of the update package. It
belongs to the installation:

- Linux: `ExecStartPre=+` in the unit, run as root by systemd.
- Windows: the swap block in `run-agent.cmd`, run as SYSTEM by the service.

Two reasons. A running JVM holds its own jar open, so something has to act at a
moment when nothing does; and on Linux the agent is unprivileged and genuinely
cannot write `/opt/camstream`, so only a privileged step can install anything.

That second property is worth keeping. It means a compromised agent cannot
rewrite its own program or swap the ffmpeg underneath itself. It does **not**
hold on Windows today, where the service runs as SYSTEM with full control of
its own directory — see `pending.md`.

### Which means the launcher itself cannot be updated remotely

An update package carries the jar. Nothing else. The unit, `run-agent.cmd`,
and every flag on the java command line belong to the *installation*, and the
only thing that rewrites them is the installer — so a change to any of them
reaches a deployed site by reinstalling it, or not at all.

This is a real limit, not a gap to close casually: the reason a compromised
agent cannot rewrite its own program is precisely that it does not get to
choose how it is launched. Handing the update package the launcher would undo
that on Linux and would need signing first.

So when a fix lives on the command line rather than in the jar, it is a
reinstall, and the estate stays mixed until every site has had one. Where
there is a choice, fix it inside the jar.

There usually is. On 2026-09-04 the agent was found writing its Windows log in
the console codepage, making the file invalid UTF-8. The obvious fix was two
`-D` flags on the java command line — correct in the repository, correct for
every future install, and unreachable for the two machines already running.
The same fix inside the jar is a static block in `Main` that installs UTF-8
streams before the first logger exists, and that one ships as an ordinary
update. Both are in place: the flags for new installs, the static block for
everyone else.

Ask the question early, because it decides whether a fix is deployable or
merely correct.

## Failure should be boring

A failed update leaves the old build running. The download is verified by being
read: a truncated or corrupt bundle fails while extracting to a temporary file,
before anything has replaced the program that would have reported the problem.
The previous jar is kept as `.previous` so a build that will not start has
something to fall back to.

Keep it that way. An update that can half-apply is worse than one that refuses.
